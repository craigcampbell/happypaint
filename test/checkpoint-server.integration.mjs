/* eslint-env node */
// Phase-3 trusted checkpoints — raw-WS server integration. Boots the REAL
// server.js (anonymous: no PocketBase) with ENABLE_TRUSTED_CHECKPOINTS=1 and a
// real Chromium renderer worker, then drives bare WebSocket clients:
//
//   1. ready-checkpoint generation (background build on qualifying ops, seen
//      via /api/admin/metrics) and a WARM JOIN: history.checkpoint present,
//      ops = empty tail, per-layer PNGs + hashes + mix state validate;
//   2. appended tail: ops after the watermark ride history.ops — the cache is
//      REUSED, old ops never truncated from the room (a legacy join still
//      gets the full list);
//   3. renderer-version mismatch and legacy (no cp) clients: ordinary full
//      history, no checkpoint key;
//   4. checkpoint_nack: exactly one full resend on THAT connection, no retry
//      loop, other connections unaffected;
//   5. moderation hide DURING a build: result invalidated, never served;
//   6. layer structure change invalidates, rebuild restores warm joins, and a
//      clear invalidates again;
//   7. safe-cut gating: leading text op / unseeded stroke / never-closed
//      stroke => no checkpoint, ordinary history intact;
//   8. target eligibility: seeded oil/knife(wet)/eraser/image/marker all pass
//      the cut (the MAIN-like mix is NOT gated away);
//   9. missing Chromium boot: checkpoints disabled, joins ordinary, startup
//      unaffected;
//  10. corrupt worker boot (FIXTURE worker, clearly labelled): corrupt frames
//      rejected, build failures counted, joins ordinary, no crash;
//  11. flag-off boot: feature inert, anonymous path ordinary.
//
//   node test/checkpoint-server.integration.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { gunzipSync } from 'node:zlib';
import { checkpointRendererVersion } from '../server/checkpointVersion.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = '/home/craig/.hermes/cache/scratch/checkpoint-server';
const ADMIN_KEY = 'checkpoint-test-admin';
const VERSION = checkpointRendererVersion();
const BAD_VERSION = 'f'.repeat(64);
const CHROME = [process.env.CHECKPOINT_CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(Boolean).find((p) => existsSync(p));
const CORRUPT_WORKER = path.join(ROOT, 'test', 'fixtures', 'corruptCheckpointWorker.mjs');

if (!CHROME) {
  console.error('no chrome executable found — set CHECKPOINT_CHROME_PATH');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny raw-WS client -----------------------------------------------------
class CpClient {
  constructor(port, { room, gz = true, cp = null, name = 'c' } = {}) {
    const params = new URLSearchParams({ room });
    if (gz) params.set('gz', '1');
    if (cp) params.set('cp', cp);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${params}`);
    this.messages = [];
    this.checkpointFrames = 0;
    this.label = name;
    this.ws.on('message', (raw, isBinary) => {
      let msg;
      try {
        msg = isBinary ? JSON.parse(gunzipSync(raw).toString('utf8')) : JSON.parse(raw.toString());
      } catch { return; }
      if (msg && msg.type === 'history' && msg.checkpoint) this.checkpointFrames += 1;
      this.messages.push(msg);
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: connect timeout`)), 8000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'auth', token: null })));
      this.ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === 'connected') { clearTimeout(timer); resolve(m); }
        } catch { /* ignore */ }
      });
      this.ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  sendOp(op) { this.send({ type: 'op', op }); }
  histories() { return this.messages.filter((m) => m.type === 'history'); }
  async waitFor(test, label, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(test);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${this.label}: timeout waiting for ${label}`);
      await sleep(60);
    }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// ---- server boot ------------------------------------------------------------
function bootServer(port, extraEnv = {}) {
  const dataDir = path.join(SCRATCH, `data-${port}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      PB_URL: '',
      ADMIN_KEY,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  return { child, log };
}
async function waitHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server :${port} never became healthy`);
    await sleep(150);
  }
}
// Kill a booted server and WAIT for the port to free, so a later boot in the
// same suite can never race a zombie listener (SIGTERM's graceful shutdown
// can linger behind keep-alive HTTP connections).
async function killServer(booted) {
  if (!booted || !booted.child) return;
  try { booted.child.kill('SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 30 && booted.child.exitCode === null; i += 1) await sleep(100);
  if (booted.child.exitCode === null) {
    try { booted.child.kill('SIGKILL'); } catch { /* gone */ }
    for (let i = 0; i < 20 && booted.child.exitCode === null; i += 1) await sleep(50);
  }
}
async function metrics(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/metrics`, { headers: { 'x-admin-key': ADMIN_KEY } });
  assert.ok(res.ok, `metrics endpoint reachable (${res.status})`);
  return (await res.json()).checkpoints;
}
async function waitMetric(port, test, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await metrics(port);
    if (test(last)) return last;
    if (Date.now() > deadline) throw new Error(`timeout waiting for metric: ${label} (last ${JSON.stringify(last)})`);
    await sleep(300);
  }
}

// ---- op factories (all seeded + closed unless noted) ------------------------
let strokeSeq = 0;
const stroke = (seed, color, pts, { brush = 'marker', v = 0, end = true, seeded = true, layerId = null } = {}) => {
  strokeSeq += 1;
  const settings = { brush, color, size: 24, opacity: 1 };
  if (v) settings.v = v;
  if (seeded) settings.seed = seed;
  const op = { kind: 'draw', strokeId: `st${seed}-${strokeSeq}`, settings, points: pts.map(([x, y]) => ({ x, y })) };
  if (end) op.end = true;
  if (layerId) op.layerId = layerId;
  return op;
};
const RED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBgQAAA9+AED0yx0AAAAAABJRU5ErkJggg==';

function validateCheckpoint(msg, { throughOpId = null, layerCount = 1 } = {}) {
  const cp = msg.checkpoint;
  assert.ok(cp && typeof cp === 'object', 'history.checkpoint present');
  assert.equal(cp.schemaVersion, 1);
  assert.equal(cp.rendererVersion, VERSION, 'checkpoint carries the current renderer fingerprint');
  assert.ok(Array.isArray(cp.frames) && cp.frames.length === 1, 'one frame descriptor (pilot)');
  const frame = cp.frames[0];
  if (throughOpId != null) assert.equal(frame.throughOpId, throughOpId, 'watermark');
  assert.ok(Number.isSafeInteger(frame.throughOpId) && frame.throughOpId > 0);
  assert.equal(frame.layers.length, layerCount);
  for (const layer of frame.layers) {
    const png = Buffer.from(layer.pngBase64, 'base64');
    assert.equal(png.subarray(0, 4).toString('hex'), '89504e47', 'PNG magic');
    assert.match(layer.pngSha256, /^[a-f0-9]{64}$/);
    assert.match(layer.rgbaSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(frame.mixState.version, 1);
  assert.equal(frame.mixState.width, 500);
  assert.equal(frame.mixState.height, 313);
  assert.ok(Array.isArray(msg.frames) && msg.frames.length >= 1, 'authoritative frames metadata retained');
  return frame;
}

const results = [];
async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  [PASS] ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false, reason: err.message });
    console.log(`  [FAIL] ${name}\n         ↳ ${err.message}`);
  }
}

const MAIN_PORT = 19121;
const boot = bootServer(MAIN_PORT, {
  ENABLE_TRUSTED_CHECKPOINTS: '1',
  CHECKPOINT_CHROME_PATH: CHROME,
  CHECKPOINT_MIN_OPS: '4',
  CHECKPOINT_REBUILD_TAIL: '100000', // no automatic rebuilds: suites control timing
  CHECKPOINT_JOB_TIMEOUT_MS: '60000',
});

const room = (prefix) => `${prefix}${Math.floor(Math.random() * 900 + 100)}`;

async function main() {
  await waitHealth(MAIN_PORT);
  console.log('server healthy on', MAIN_PORT);

  // -- 1+2: generation, warm join, appended tail, legacy full -----------------
  const WARM = room('ZWM');
  let watermark = null;
  await scenario('ready generation + warm join (checkpoint, empty tail) + appended tail reuse', async () => {
    const a = new CpClient(MAIN_PORT, { room: WARM, name: 'A' });
    await a.ready;
    for (let i = 0; i < 4; i += 1) a.sendOp(stroke(100 + i, '#cc0000', [[100 + i * 50, 100], [300 + i * 50, 300]]));
    await waitMetric(MAIN_PORT, (m) => m.builds >= 1, 'first checkpoint build');
    const m0 = await metrics(MAIN_PORT);
    assert.equal(m0.entries, 1, 'one cache entry');
    assert.ok(m0.bytes > 0, 'cache accounts bytes');

    const b = new CpClient(MAIN_PORT, { room: WARM, cp: VERSION, name: 'B' });
    await b.ready;
    const hist = await b.waitFor((m) => m.type === 'history', 'warm history');
    assert.equal(b.checkpointFrames, 1);
    const frame = validateCheckpoint(hist, { layerCount: 1 });
    watermark = frame.throughOpId;
    assert.equal(hist.ops.length, 0, 'prefix covered everything: empty tail');

    // Two ops AFTER the watermark: the cache is reused, the tail rides ops.
    a.sendOp(stroke(200, '#00cc00', [[500, 500], [700, 700]]));
    a.sendOp(stroke(201, '#00cc00', [[800, 800], [900, 900]]));
    await sleep(250);
    const c = new CpClient(MAIN_PORT, { room: WARM, cp: VERSION, name: 'C' });
    await c.ready;
    const hist2 = await c.waitFor((m) => m.type === 'history', 'warm history w/ tail');
    validateCheckpoint(hist2, { throughOpId: watermark });
    assert.equal(hist2.ops.length, 2, 'exact tail above the frozen watermark');
    assert.ok(hist2.ops.every((op) => op.opId > watermark), 'tail ops all newer than watermark');

    // The room's history was never truncated: a legacy join replays ALL ops.
    const legacy = new CpClient(MAIN_PORT, { room: WARM, gz: false, name: 'legacy' });
    await legacy.ready;
    const full = await legacy.waitFor((m) => m.type === 'history', 'legacy full history');
    assert.ok(!full.checkpoint, 'legacy join has no checkpoint key');
    assert.equal(full.ops.length, 6, 'full op history retained');
    const m1 = await metrics(MAIN_PORT);
    assert.ok(m1.hits >= 2, `warm hits counted (${m1.hits})`);
    a.close(); b.close(); c.close(); legacy.close();
  });

  // -- 3: version mismatch / garbage cp => ordinary ----------------------------
  await scenario('renderer-version mismatch + garbage cp => ordinary full history', async () => {
    const stale = new CpClient(MAIN_PORT, { room: WARM, cp: BAD_VERSION, name: 'stale' });
    await stale.ready;
    const h1 = await stale.waitFor((m) => m.type === 'history', 'stale-version history');
    assert.ok(!h1.checkpoint, 'mismatched renderer fingerprint declines checkpoint');
    assert.equal(h1.ops.length, 6);
    const garbage = new CpClient(MAIN_PORT, { room: WARM, cp: 'not-a-version', name: 'garbage' });
    await garbage.ready;
    const h2 = await garbage.waitFor((m) => m.type === 'history', 'garbage-cp history');
    assert.ok(!h2.checkpoint && h2.ops.length === 6);
    stale.close(); garbage.close();
  });

  // -- 4: checkpoint_nack: per-connection disable + one full resend ------------
  await scenario('checkpoint_nack: one full resend, this connection only, no loop', async () => {
    const before = await metrics(MAIN_PORT);
    const e = new CpClient(MAIN_PORT, { room: WARM, cp: VERSION, name: 'E' });
    await e.ready;
    await e.waitFor((m) => m.type === 'history' && m.checkpoint, 'checkpoint baseline');
    assert.equal(e.checkpointFrames, 1);
    e.send({ type: 'checkpoint_nack' });
    const full = await e.waitFor((m) => m.type === 'history' && !m.checkpoint, 'full resend after nack');
    assert.equal(full.ops.length, 6, 'nack resend is the complete ordinary history');
    await sleep(600); // any loop would have delivered another checkpoint by now
    assert.equal(e.checkpointFrames, 1, 'no checkpoint retry loop after nack');
    const after = await metrics(MAIN_PORT);
    assert.equal(after.nacks, before.nacks + 1, 'nack counted');
    // Another capable connection still gets checkpoints (per-connection only).
    const f = new CpClient(MAIN_PORT, { room: WARM, cp: VERSION, name: 'F' });
    await f.ready;
    await f.waitFor((m) => m.type === 'history' && m.checkpoint, 'checkpoint still served to others');
    e.close(); f.close();
  });

  // -- 5: moderation hide DURING a build invalidates the render ----------------
  await scenario('moderation hide during build: result invalidated, never served', async () => {
    const RACE = room('ZRC');
    const g = new CpClient(MAIN_PORT, { room: RACE, name: 'G' });
    await g.ready; // first joiner of a friends room = guest host (anonymous path)
    const before = await metrics(MAIN_PORT);
    for (let i = 0; i < 4; i += 1) g.sendOp(stroke(300 + i, '#0000cc', [[100, 100 + i * 40], [400, 140 + i * 40]]));
    // Land the hide while Chromium renders (build started on the 4th op).
    await sleep(30);
    const ops = g.messages.filter((m) => m.type === 'op').map((m) => m.op);
    // The joining socket's own ops are broadcast to others, not echoed; ask a
    // fresh text join for the op ids instead.
    let firstOpId = ops[0] && ops[0].opId;
    if (firstOpId == null) {
      const probe = new CpClient(MAIN_PORT, { room: RACE, gz: false, name: 'probe' });
      await probe.ready;
      const h = await probe.waitFor((m) => m.type === 'history', 'probe history');
      firstOpId = h.ops[0].opId;
      probe.close();
    }
    g.send({ type: 'mod_hide', opIds: [firstOpId] });
    await waitMetric(MAIN_PORT, (m) => m.invalidations > before.invalidations, 'mid-build invalidation');
    const j = new CpClient(MAIN_PORT, { room: RACE, cp: VERSION, name: 'J' });
    await j.ready;
    const h = await j.waitFor((m) => m.type === 'history', 'post-invalidation history');
    assert.ok(!h.checkpoint, 'invalidated build never served');
    assert.equal(h.ops.length, 3, 'hidden op excluded from ordinary replay');
    g.close(); j.close();
  });

  // -- 6: layer structure change + clear invalidate; rebuild re-warms ----------
  await scenario('layer struct change + clear invalidate; background rebuild re-warms', async () => {
    const STRUCT = room('ZST');
    const k = new CpClient(MAIN_PORT, { room: STRUCT, name: 'K' });
    await k.ready;
    const m0 = await metrics(MAIN_PORT);
    for (let i = 0; i < 4; i += 1) k.sendOp(stroke(400 + i, '#cc6600', [[200, 200 + i * 30], [500, 230 + i * 30]]));
    await waitMetric(MAIN_PORT, (m) => m.builds > m0.builds, 'struct-room build');
    const warm1 = new CpClient(MAIN_PORT, { room: STRUCT, cp: VERSION, name: 'warm1' });
    await warm1.ready;
    await warm1.waitFor((m) => m.type === 'history' && m.checkpoint, 'warm before struct change');

    k.send({ type: 'layer_add' });
    await sleep(250);
    // Baseline BEFORE the cold join: the join itself triggers the rebuild, and
    // a warm-Chromium rebuild can land faster than a metrics sample after it.
    const m1 = await metrics(MAIN_PORT);
    const cold = new CpClient(MAIN_PORT, { room: STRUCT, cp: VERSION, name: 'cold' });
    await cold.ready;
    const hcold = await cold.waitFor((m) => m.type === 'history', 'struct-changed history');
    assert.ok(!hcold.checkpoint, 'layer structure change invalidates the cached frame');
    assert.equal(hcold.frames[0].layers.length, 2);

    await waitMetric(MAIN_PORT, (m) => m.builds > m1.builds, 'rebuild after struct change');
    const warm2 = new CpClient(MAIN_PORT, { room: STRUCT, cp: VERSION, name: 'warm2' });
    await warm2.ready;
    const hwarm = await warm2.waitFor((m) => m.type === 'history' && m.checkpoint, 're-warmed history');
    validateCheckpoint(hwarm, { layerCount: 2 });

    // A host clear wipes history: the cached frame must never serve again.
    k.send({ type: 'clear' });
    await sleep(300);
    const post = new CpClient(MAIN_PORT, { room: STRUCT, cp: VERSION, name: 'postclear' });
    await post.ready;
    const hpost = await post.waitFor((m) => m.type === 'history', 'post-clear history');
    assert.ok(!hpost.checkpoint, 'clear invalidates the checkpoint');
    assert.equal(hpost.ops.length, 0, 'cleared room is empty');
    k.close(); warm1.close(); cold.close(); warm2.close(); post.close();
  });

  // -- 7: safe-cut gating -------------------------------------------------------
  await scenario('gating: leading text op / unseeded / never-closed stroke get no checkpoint', async () => {
    const GATE = room('ZGT');
    const g1 = new CpClient(MAIN_PORT, { room: GATE, name: 'g1' });
    await g1.ready;
    g1.sendOp({ kind: 'text', point: { x: 100, y: 100 }, text: 'hello', opts: {} });
    for (let i = 0; i < 4; i += 1) g1.sendOp(stroke(500 + i, '#111111', [[100, 100], [200, 200]]));
    await sleep(400);
    const j1 = new CpClient(MAIN_PORT, { room: GATE, cp: VERSION, name: 'j1' });
    await j1.ready;
    const h1 = await j1.waitFor((m) => m.type === 'history', 'gate history');
    assert.ok(!h1.checkpoint, 'text op blocks the prefix');
    assert.equal(h1.ops.length, 5, 'ordinary history intact');
    g1.close(); j1.close();

    const UNSEEDED = room('ZUS');
    const g2 = new CpClient(MAIN_PORT, { room: UNSEEDED, name: 'g2' });
    await g2.ready;
    g2.sendOp(stroke(600, '#222222', [[100, 100], [200, 200]], { seeded: false }));
    for (let i = 0; i < 4; i += 1) g2.sendOp(stroke(601 + i, '#333333', [[100, 100], [200, 200]]));
    await sleep(400);
    const j2 = new CpClient(MAIN_PORT, { room: UNSEEDED, cp: VERSION, name: 'j2' });
    await j2.ready;
    const h2 = await j2.waitFor((m) => m.type === 'history', 'unseeded history');
    assert.ok(!h2.checkpoint, 'unseeded stroke blocks the prefix');
    g2.close(); j2.close();

    const OPEN = room('ZOP');
    const g3 = new CpClient(MAIN_PORT, { room: OPEN, name: 'g3' });
    await g3.ready;
    g3.sendOp(stroke(700, '#444444', [[100, 100], [200, 200]], { end: false })); // never closed
    for (let i = 0; i < 4; i += 1) g3.sendOp(stroke(701 + i, '#555555', [[100, 100], [200, 200]]));
    await sleep(400);
    const j3 = new CpClient(MAIN_PORT, { room: OPEN, cp: VERSION, name: 'j3' });
    await j3.ready;
    const h3 = await j3.waitFor((m) => m.type === 'history', 'open-stroke history');
    assert.ok(!h3.checkpoint, 'a never-closed stroke blocks any cut after its start');
    g3.close(); j3.close();

    const m = await metrics(MAIN_PORT);
    assert.ok(m.skippedIneligible >= 2, `ineligible skips counted (${m.skippedIneligible})`);
    assert.ok(m.builds >= 3, 'eligible rooms still built (gating did not over-fire)');
  });

  // -- 8: target eligibility (MAIN-like seeded wet mix NOT gated away) ---------
  await scenario('target eligibility: seeded oil/knife/eraser/image/marker all checkpoint', async () => {
    const OIL = room('ZOL');
    const o = new CpClient(MAIN_PORT, { room: OIL, name: 'O' });
    await o.ready;
    const m0 = await metrics(MAIN_PORT);
    o.sendOp(stroke(800, '#8b4513', [[200, 300], [600, 500], [900, 400]], { v: 2, brush: 'oil' }));
    o.sendOp(stroke(801, '#d2b48c', [[300, 600], [700, 800]], { v: 2, brush: 'knife' }));
    o.sendOp(stroke(802, '#000000', [[400, 400], [500, 500]], { brush: 'eraser' }));
    o.sendOp({ kind: 'image', dataUrl: `data:image/png;base64,${RED_PNG_B64}`, x: 1000, y: 1000, w: 120, h: 120 });
    o.sendOp(stroke(803, '#123456', [[100, 900], [900, 1100]]));
    await waitMetric(MAIN_PORT, (m) => m.builds > m0.builds, 'oil-room build');
    const j = new CpClient(MAIN_PORT, { room: OIL, cp: VERSION, name: 'oiljoin' });
    await j.ready;
    const h = await j.waitFor((m) => m.type === 'history' && m.checkpoint, 'oil checkpoint');
    // The whole point: the seeded wet mix (oil/knife + eraser + image +
    // marker) is NOT gated away — a checkpoint exists and prefix+tail cover
    // the full history exactly.
    const frame = validateCheckpoint(h, { layerCount: 1 });
    const covered = h.ops.map((op) => op.opId);
    assert.ok(covered.every((id) => id > frame.throughOpId), 'tail strictly above watermark');
    assert.ok(frame.throughOpId >= 4, 'prefix covers at least oil/knife/eraser/image');
    assert.equal(covered.length, 5 - [1, 2, 3, 4, 5].filter((id) => id <= frame.throughOpId).length,
      'prefix + tail = the complete 5-op history, nothing lost');
    o.close(); j.close();
  });

  const mainMetrics = await metrics(MAIN_PORT);
  console.log('  main-server checkpoint metrics:', JSON.stringify(mainMetrics));
  await killServer(boot);

  // -- 9: missing Chromium boot --------------------------------------------------
  await scenario('missing Chromium: checkpoints disabled, startup + joins unaffected', async () => {
    const PORT = 19220 + Math.floor(Math.random() * 60);
    const b2 = bootServer(PORT, { ENABLE_TRUSTED_CHECKPOINTS: '1', CHECKPOINT_CHROME_PATH: '/nonexistent/no-chrome', CHECKPOINT_MIN_OPS: '4' });
    try {
      await waitHealth(PORT);
      const m = await metrics(PORT);
      assert.equal(m.enabled, false);
      assert.equal(m.reason, 'chrome_missing');
      const R = room('ZNC');
      const a = new CpClient(PORT, { room: R, name: 'a' });
      await a.ready;
      for (let i = 0; i < 4; i += 1) a.sendOp(stroke(900 + i, '#666666', [[100, 100], [200, 200]]));
      await sleep(400);
      const j = new CpClient(PORT, { room: R, cp: VERSION, name: 'j' });
      await j.ready;
      const h = await j.waitFor((x) => x.type === 'history', 'no-chrome history');
      assert.ok(!h.checkpoint && h.ops.length === 4, 'ordinary full history without a worker');
      a.close(); j.close();
    } finally {
      await killServer(b2);
    }
  });

  // -- 10: corrupt worker (FIXTURE) ---------------------------------------------
  await scenario('corrupt worker responses rejected (fixture worker), joins stay ordinary', async () => {
    const PORT = 19320 + Math.floor(Math.random() * 60);
    const b3 = bootServer(PORT, {
      ENABLE_TRUSTED_CHECKPOINTS: '1',
      CHECKPOINT_CHROME_PATH: CHROME,
      CHECKPOINT_WORKER_ENTRY: CORRUPT_WORKER,
      CORRUPT_MODE: 'hash',
      CHECKPOINT_MIN_OPS: '4',
    });
    try {
      await waitHealth(PORT);
      const R = room('ZCF');
      const a = new CpClient(PORT, { room: R, name: 'a' });
      await a.ready;
      for (let i = 0; i < 4; i += 1) a.sendOp(stroke(950 + i, '#777777', [[100, 100], [200, 200]]));
      const m = await waitMetric(PORT, (x) => x.buildFailures >= 1, 'corrupt build rejected');
      assert.equal(m.builds, 0, 'a corrupt frame is never cached');
      assert.equal(m.entries, 0);
      const j = new CpClient(PORT, { room: R, cp: VERSION, name: 'j' });
      await j.ready;
      const h = await j.waitFor((x) => x.type === 'history', 'corrupt-worker history');
      assert.ok(!h.checkpoint && h.ops.length === 4, 'corrupt worker => ordinary history');
      a.close(); j.close();
    } finally {
      await killServer(b3);
      if (results[results.length - 1] && !results[results.length - 1].ok) {
        console.log('  --- corrupt-boot server log tail ---');
        console.log(b3.log.slice(-15).map((l) => `  ${l.trimEnd()}`).join('\n'));
      }
    }
  });

  // -- 11: flag off ---------------------------------------------------------------
  await scenario('flag off: feature fully inert on the anonymous path', async () => {
    const PORT = 19420 + Math.floor(Math.random() * 60);
    const b4 = bootServer(PORT, { CHECKPOINT_CHROME_PATH: CHROME, CHECKPOINT_MIN_OPS: '4' });
    try {
      await waitHealth(PORT);
      const m = await metrics(PORT);
      assert.equal(m.enabled, false);
      assert.equal(m.reason, 'flag_off');
      assert.equal(m.worker, null, 'no worker ever constructed');
      const R = room('ZOF');
      const a = new CpClient(PORT, { room: R, name: 'a' });
      await a.ready;
      for (let i = 0; i < 4; i += 1) a.sendOp(stroke(990 + i, '#888888', [[100, 100], [200, 200]]));
      await sleep(400);
      const j = new CpClient(PORT, { room: R, cp: VERSION, name: 'j' });
      await j.ready;
      const h = await j.waitFor((x) => x.type === 'history', 'flag-off history');
      assert.ok(!h.checkpoint && h.ops.length === 4);
      const m2 = await metrics(PORT);
      assert.equal(m2.builds, 0);
      a.close(); j.close();
    } finally {
      await killServer(b4);
    }
  });
}

main()
  .catch((err) => {
    results.push({ name: '(suite)', ok: false, reason: err.message });
    console.error('suite crashed:', err);
  })
  .finally(async () => {
    await killServer(boot).catch(() => {});
    const pass = results.filter((r) => r.ok).length;
    const fail = results.length - pass;
    console.log(`\n  ${pass} passed, ${fail} failed, ${results.length} total`);
    if (fail > 0) {
      console.log('  --- server log tail ---');
      console.log(boot.log.slice(-20).map((l) => `  ${l.trimEnd()}`).join('\n'));
    }
    process.exit(fail > 0 ? 1 : 0);
  });
