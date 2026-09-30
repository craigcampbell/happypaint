/* eslint-env node */
// Phase-4 trusted ANIMATION checkpoints — raw-WS server integration with the
// REAL renderer worker (Chromium). Boots the real server.js (anonymous: no
// PocketBase) with ENABLE_TRUSTED_CHECKPOINTS=1 and drives bare WebSocket
// clients through multi-scene, multi-layer flipbook rooms:
//
//   1. lazy requested-frame builds: a capable join gets the ordinary scene
//      baseline while the FIRST frame's checkpoint renders in the background
//      — never an eager whole-film render;
//   2. warm join PARTIAL COVERAGE: history.checkpoint.frames is a SUBSET of
//      history.frames, ops keep global order (tail above the watermark for
//      checkpointed frames, FULL ops for uncached frames), 3-layer assets +
//      hashes + mix state validate;
//   3. scene_fetch.frameId priority: the requested frame's build is kicked,
//      the next fetch covers it too (bounded: no rebuild storm);
//   4. checkpoint_nack resends the CURRENT scene via ordinary scene history
//      (not all room frames), disables cp for that connection only;
//   5. appended ops ride the tail — the cached frame is REUSED (no rebuild);
//   6. moderation hide DURING a build: result invalidated, never served;
//   7. a layer change on ANOTHER frame keeps the cached frame servable; a
//      layer change on the CACHED frame invalidates only it;
//   8. a frame clear (content generation) invalidates;
//   9. server RESTART: memory-only cache is gone, early frames/ops are fully
//      preserved (no front trim), checkpoints rebuild lazily;
//  10. legacy (no cp) animation clients get the ordinary scene history;
//  11. flag-off boot: animation rooms behave exactly as before, no builds.
//
//   node test/checkpoint-animation.integration.mjs
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
const SCRATCH = '/home/craig/.hermes/cache/scratch/phase4backend/checkpoint-animation';
const ADMIN_KEY = 'checkpoint-anim-admin';
const VERSION = checkpointRendererVersion();
const CHROME = [process.env.CHECKPOINT_CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium']
  .filter(Boolean).find((p) => existsSync(p));
const PORT = 19131;

if (!CHROME) {
  console.error('no chrome executable found — set CHECKPOINT_CHROME_PATH');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny raw-WS client -------------------------------------------------------
class CpClient {
  constructor({ room, gz = true, cp = null, name = 'c' } = {}) {
    const params = new URLSearchParams({ room });
    if (gz) params.set('gz', '1');
    if (cp) params.set('cp', cp);
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${params}`);
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
  mark() { return this.messages.length; }
  async waitFor(test, label, timeoutMs = 12000, from = 0) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.slice(from).find(test);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${this.label}: timeout waiting for ${label}`);
      await sleep(60);
    }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// ---- server boot ----------------------------------------------------------------
function bootServer(extraEnv = {}, { keepData = false } = {}) {
  const dataDir = path.join(SCRATCH, 'data');
  if (!keepData) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
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
  return { child, log, dataDir };
}
async function waitHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server never became healthy');
    await sleep(150);
  }
}
async function killServer(booted) {
  if (!booted || !booted.child) return;
  try { booted.child.kill('SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 30 && booted.child.exitCode === null; i += 1) await sleep(100);
  if (booted.child.exitCode === null) {
    try { booted.child.kill('SIGKILL'); } catch { /* gone */ }
    for (let i = 0; i < 20 && booted.child.exitCode === null; i += 1) await sleep(50);
  }
}
async function metrics() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/metrics`, { headers: { 'x-admin-key': ADMIN_KEY } });
  assert.ok(res.ok, `metrics endpoint reachable (${res.status})`);
  return (await res.json()).checkpoints;
}
async function waitMetric(test, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await metrics();
    if (test(last)) return last;
    if (Date.now() > deadline) throw new Error(`timeout waiting for metric: ${label} (last ${JSON.stringify(last)})`);
    await sleep(300);
  }
}

// ---- op factories (all seeded + closed) -------------------------------------------
let strokeSeq = 0;
const stroke = (seed, color, pts, { frameId = null, layerId = null, brush = 'marker', v = 0 } = {}) => {
  strokeSeq += 1;
  const settings = { brush, color, size: 24, opacity: 1, seed };
  if (v) settings.v = v;
  const op = { kind: 'draw', strokeId: `an${seed}-${strokeSeq}`, settings, points: pts.map(([x, y]) => ({ x, y })), end: true };
  if (frameId) op.frameId = frameId;
  if (layerId) op.layerId = layerId;
  return op;
};

function validateSceneCheckpoint(msg, { expectFrames, sceneId }) {
  const cp = msg.checkpoint;
  assert.ok(cp && typeof cp === 'object', 'history.checkpoint present');
  assert.equal(cp.schemaVersion, 1);
  assert.equal(cp.rendererVersion, VERSION, 'renderer fingerprint rides the envelope');
  assert.equal(msg.sceneId, sceneId, 'scene-scoped baseline');
  assert.ok(Array.isArray(cp.frames) && cp.frames.length === expectFrames.length,
    `checkpoint covers exactly ${expectFrames.length} frame(s)`);
  const msgFrameIds = new Set(msg.frames.map((f) => f.id));
  const byId = new Map();
  for (const frame of cp.frames) {
    assert.ok(msgFrameIds.has(frame.frameId), 'descriptor names an authoritative frame');
    assert.ok(Number.isSafeInteger(frame.throughOpId) && frame.throughOpId > 0, 'per-frame watermark');
    for (const layer of frame.layers) {
      const png = Buffer.from(layer.pngBase64, 'base64');
      assert.equal(png.subarray(0, 4).toString('hex'), '89504e47', 'PNG magic');
      assert.match(layer.pngSha256, /^[a-f0-9]{64}$/);
      assert.match(layer.rgbaSha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(frame.mixState.version, 1);
    assert.equal(frame.mixState.width, 500);
    assert.equal(frame.mixState.height, 313);
    byId.set(frame.frameId, frame);
  }
  return byId;
}
const assertMonotonic = (ops, what) => {
  for (let i = 1; i < ops.length; i += 1) {
    assert.ok((ops[i].opId || 0) > (ops[i - 1].opId || 0), `${what}: global op order preserved`);
  }
};

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

const room = (prefix) => `${prefix}${Math.floor(Math.random() * 900 + 100)}`;

// Build a multi-scene animation room: scene 1 = f0 (3 layers), f2, f3;
// scene 2 = one frame. Returns ids. Draws seeded strokes on every frame.
async function buildFilmRoom(code, { scene2 = true } = {}) {
  const host = new CpClient({ room: code, name: 'host' });
  await host.ready;
  host.send({ type: 'set_animation', enabled: true });
  await host.waitFor((m) => m.type === 'room_animation' && m.enabled === true, 'animation on');
  const scene1 = 's0';
  // Three layers on f0.
  host.send({ type: 'layer_add', frameId: 'f0' });
  const la1 = await host.waitFor((m) => m.type === 'layer_add' && m.frameId === 'f0', 'layer_add 1');
  host.send({ type: 'layer_add', frameId: 'f0' });
  const la2 = await host.waitFor((m) => m.type === 'layer_add' && m.frameId === 'f0' && m.layers.length === 3, 'layer_add 2');
  const l1 = la1.layers[la1.layers.length - 1].id;
  const l2 = la2.layers[la2.layers.length - 1].id;
  // Two more frames in scene 1.
  host.send({ type: 'frame_add' });
  const fa2 = await host.waitFor((m) => m.type === 'frame_add' && !m.duplicateOf, 'frame f2');
  const f2 = fa2.frame.id;
  host.send({ type: 'frame_add' });
  const fa3 = await host.waitFor((m) => m.type === 'frame_add' && m.frame.id !== f2, 'frame f3');
  const f3 = fa3.frame.id;
  // Scene 2 with its own first frame.
  let scene2Id = null;
  let fS2 = null;
  if (scene2) {
    host.send({ type: 'scene_add' });
    const sa = await host.waitFor((m) => m.type === 'scene_add', 'scene_add');
    scene2Id = sa.scene.id;
    // scene_add broadcasts no frame_add: the scene's first frame rides the
    // scenes meta in the same message.
    const meta = sa.scenes.find((s) => s.id === scene2Id);
    fS2 = meta && meta.frames[0] && meta.frames[0].id;
    assert.ok(fS2, 'scene 2 first frame id from scenes meta');
  }
  // Seeded strokes: f0 gets three (one per layer, incl. a wet oil stroke on
  // L0 so the mix state is real), f2/f3/scene2 two each on their base layer.
  host.sendOp(stroke(11, '#8b4513', [[200, 300], [600, 500], [900, 400]], { frameId: 'f0', layerId: 'L0', brush: 'oil', v: 2 }));
  host.sendOp(stroke(12, '#cc0000', [[100, 100], [300, 300]], { frameId: 'f0', layerId: l1 }));
  host.sendOp(stroke(13, '#00cc00', [[400, 400], [700, 600]], { frameId: 'f0', layerId: l2 }));
  host.sendOp(stroke(14, '#0000cc', [[150, 150], [450, 450]], { frameId: f2 }));
  host.sendOp(stroke(15, '#00cccc', [[500, 200], [800, 500]], { frameId: f2 }));
  host.sendOp(stroke(16, '#cc00cc', [[250, 600], [650, 900]], { frameId: f3 }));
  host.sendOp(stroke(17, '#cccc00', [[350, 700], [750, 1000]], { frameId: f3 }));
  if (fS2) {
    host.sendOp(stroke(18, '#333333', [[100, 800], [400, 1100]], { frameId: fS2 }));
    host.sendOp(stroke(19, '#777777', [[200, 900], [500, 1200]], { frameId: fS2 }));
  }
  await sleep(300);
  return { host, scene1, f0: 'f0', f2, f3, l1, l2, scene2Id, fS2 };
}

let boot = bootServer({
  ENABLE_TRUSTED_CHECKPOINTS: '1',
  CHECKPOINT_CHROME_PATH: CHROME,
  CHECKPOINT_MIN_OPS: '4',
  CHECKPOINT_FRAME_MIN_OPS: '2',
  CHECKPOINT_REBUILD_TAIL: '100000', // no automatic tail rebuilds: suites control timing
  CHECKPOINT_JOB_TIMEOUT_MS: '60000',
});

async function main() {
  await waitHealth();
  console.log('server healthy on', PORT);

  const FILM = room('ZFM');
  const film = await buildFilmRoom(FILM);
  const { scene1, f0, f2, f3, scene2Id, fS2 } = film;

  // -- 1+2: lazy build, warm join partial coverage ------------------------------
  let f0Watermark = null;
  await scenario('lazy requested-frame build + warm join partial coverage (subset + global-order ops)', async () => {
    // A capable join BEFORE anything is cached: ordinary scene baseline, and
    // the first frame's build kicks in the background.
    const cold = new CpClient({ room: FILM, cp: VERSION, name: 'cold' });
    await cold.ready;
    const hCold = await cold.waitFor((m) => m.type === 'history', 'cold scene baseline');
    assert.ok(!hCold.checkpoint, 'no checkpoint before any build');
    assert.equal(hCold.ops.length, 7, 'ordinary baseline carries all scene-1 ops');
    await waitMetric((m) => m.builds >= 1, 'lazy first-frame build');
    const m1 = await metrics();
    assert.equal(m1.entries, 1, 'exactly one frame cached — no eager film render');

    const warm = new CpClient({ room: FILM, cp: VERSION, name: 'warm' });
    await warm.ready;
    const hist = await warm.waitFor((m) => m.type === 'history' && m.checkpoint, 'warm checkpoint baseline');
    const descriptors = validateSceneCheckpoint(hist, { expectFrames: [f0], sceneId: scene1 });
    const f0Frame = hist.frames.find((f) => f.id === f0);
    assert.equal(descriptors.get(f0).layers.length, 3, 'all three layers rendered');
    assert.equal(f0Frame.layers.length, 3, 'authoritative metadata keeps the full layer stack');
    f0Watermark = descriptors.get(f0).throughOpId;
    // Partial coverage: f0 rides assets, f2/f3 ride FULL ops, in global order.
    assertMonotonic(hist.ops, 'warm baseline');
    assert.equal(hist.ops.length, 4, 'f2+f3 full ops, f0 fully covered');
    assert.ok(hist.ops.every((op) => op.frameId === f2 || op.frameId === f3), 'only uncached frames contribute ops');
    assert.ok(hist.ops.every((op) => op.opId > f0Watermark), 'every delivered op is newer than the watermark');
    cold.close(); warm.close();
  });

  // -- 3: scene_fetch.frameId priority ------------------------------------------
  await scenario('scene_fetch.frameId priority: requested frame builds, next fetch covers it (bounded)', async () => {
    const c = new CpClient({ room: FILM, cp: VERSION, name: 'C' });
    await c.ready;
    await c.waitFor((m) => m.type === 'history' && m.checkpoint, 'join checkpoint');
    const m1 = await metrics();
    let mark = c.mark();
    c.send({ type: 'scene_fetch', sceneId: scene1, frameId: f2 });
    await c.waitFor((m) => m.type === 'history', 'fetch baseline', 12000, mark);
    await waitMetric((m) => m.builds > m1.builds, 'requested-frame build');
    mark = c.mark();
    c.send({ type: 'scene_fetch', sceneId: scene1 });
    const hist = await c.waitFor((m) => m.type === 'history' && m.checkpoint, 'covering fetch', 12000, mark);
    const descriptors = validateSceneCheckpoint(hist, { expectFrames: [f0, f2], sceneId: scene1 });
    assert.equal(descriptors.get(f0).throughOpId, f0Watermark, 'f0 entry reused, not rebuilt');
    assert.equal(hist.ops.length, 2, 'only f3 (never requested) rides full ops');
    assert.ok(hist.ops.every((op) => op.frameId === f3));
    assertMonotonic(hist.ops, 'covering fetch');
    const m2 = await metrics();
    assert.equal(m2.builds, m1.builds + 1, 'exactly one new build — no rebuild storm');
    assert.ok(m2.entries <= 2, 'cache stays bounded to requested frames');
    c.close();
  });

  // -- 4: checkpoint_nack resends the CURRENT scene only --------------------------
  await scenario('checkpoint_nack: ordinary CURRENT-scene resend, this connection only, no loop', async () => {
    const c = new CpClient({ room: FILM, cp: VERSION, name: 'N' });
    await c.ready;
    await c.waitFor((m) => m.type === 'history' && m.checkpoint, 'join checkpoint');
    const before = await metrics();
    // Move to scene 2 (ordinary baseline — scene 2 has no cached frames yet),
    // then nack: the resend must be scene 2's ordinary history, NOT the whole
    // room and NOT another checkpoint.
    let mark = c.mark();
    c.send({ type: 'scene_fetch', sceneId: scene2Id });
    await c.waitFor((m) => m.type === 'history' && m.sceneId === scene2Id, 'scene 2 baseline', 12000, mark);
    mark = c.mark();
    const cpCount = c.checkpointFrames;
    c.send({ type: 'checkpoint_nack' });
    const full = await c.waitFor((m) => m.type === 'history' && !m.checkpoint, 'nack resend', 12000, mark);
    assert.equal(full.sceneId, scene2Id, 'resend is the CURRENT scene, not all room frames');
    assert.equal(full.frames.length, 1, 'scene 2 frames only');
    assert.ok(full.ops.every((op) => op.frameId === fS2), 'scene 2 ops only');
    await sleep(700);
    assert.equal(c.checkpointFrames, cpCount, 'no checkpoint retry loop after nack');
    const after = await metrics();
    assert.equal(after.nacks, before.nacks + 1, 'nack counted');
    // Another capable connection still gets checkpoints (per-connection only).
    const d = new CpClient({ room: FILM, cp: VERSION, name: 'D' });
    await d.ready;
    await d.waitFor((m) => m.type === 'history' && m.checkpoint, 'checkpoint still served to others');
    c.close(); d.close();
  });

  // -- 5: appended ops ride the tail (entry reused) --------------------------------
  await scenario('appended ops after the watermark ride the tail; the cached frame is reused', async () => {
    const m1 = await metrics();
    film.host.sendOp(stroke(20, '#123456', [[600, 600], [900, 900]], { frameId: f0, layerId: film.l1 }));
    await sleep(300);
    const j = new CpClient({ room: FILM, cp: VERSION, name: 'tail' });
    await j.ready;
    const hist = await j.waitFor((m) => m.type === 'history' && m.checkpoint, 'tailed checkpoint');
    const descriptors = validateSceneCheckpoint(hist, { expectFrames: [f0, f2], sceneId: scene1 });
    assert.equal(descriptors.get(f0).throughOpId, f0Watermark, 'same watermark: entry reused');
    const tails = hist.ops.filter((op) => op.frameId === f0);
    assert.equal(tails.length, 1, 'exactly the new stroke rides the f0 tail');
    assert.ok(tails[0].opId > f0Watermark);
    assertMonotonic(hist.ops, 'tailed baseline');
    const m2 = await metrics();
    assert.equal(m2.builds, m1.builds, 'no rebuild for a short tail');
    j.close();
  });

  // -- 6: moderation hide DURING a build invalidates -------------------------------
  await scenario('moderation hide during build: result invalidated, never served', async () => {
    const RACE = room('ZAR');
    const host = new CpClient({ room: RACE, name: 'racehost' });
    await host.ready;
    host.send({ type: 'set_animation', enabled: true });
    await host.waitFor((m) => m.type === 'room_animation' && m.enabled === true, 'animation on');
    for (let i = 0; i < 3; i += 1) host.sendOp(stroke(30 + i, '#0000cc', [[100, 100 + i * 40], [400, 140 + i * 40]]));
    await sleep(200);
    const before = await metrics();
    // Capable join: ordinary baseline (cold) + kicks the f0 build.
    const e = new CpClient({ room: RACE, cp: VERSION, name: 'E' });
    await e.ready;
    const baseline = await e.waitFor((m) => m.type === 'history', 'cold baseline');
    assert.ok(!baseline.checkpoint);
    const firstOpId = baseline.ops[0].opId;
    // Land the hide while Chromium renders.
    host.send({ type: 'mod_hide', opIds: [firstOpId] });
    await waitMetric((m) => m.invalidations > before.invalidations, 'mid-build invalidation');
    const f = new CpClient({ room: RACE, cp: VERSION, name: 'F' });
    await f.ready;
    const h = await f.waitFor((m) => m.type === 'history', 'post-invalidation history');
    assert.ok(!h.checkpoint, 'invalidated build never served');
    assert.equal(h.ops.length, 2, 'hidden op excluded from ordinary replay');
    host.close(); e.close(); f.close();
  });

  // -- 7: layer change on ANOTHER frame keeps the entry; on the CACHED frame drops it
  await scenario('layer struct change: other frame survives, cached frame invalidates', async () => {
    const m1 = await metrics();
    // A real structural change on a frame with no cache entry (f0 is already
    // at the 3-layer animation cap, so patch opacity — the canonical layers
    // key covers visibility/opacity).
    const f3Layer = film.host.messages.find((m) => m.type === 'history')?.frames?.find((f) => f.id === f3)?.layers?.[0]?.id || 'L0';
    film.host.send({ type: 'layer_patch', frameId: f3, layerId: f3Layer, patch: { opacity: 0.5 } });
    await sleep(300);
    const h1 = new CpClient({ room: FILM, cp: VERSION, name: 'H1' });
    await h1.ready;
    const ha = await h1.waitFor((m) => m.type === 'history' && m.checkpoint, 'checkpoint after other-frame layer change');
    validateSceneCheckpoint(ha, { expectFrames: [f0, f2], sceneId: scene1 });
    const m2 = await metrics();
    assert.equal(m2.builds, m1.builds, 'no rebuild from an unrelated frame layer change');

    film.host.send({ type: 'layer_patch', frameId: f0, layerId: film.l2, patch: { opacity: 0.5 } });
    await sleep(300);
    const h2 = new CpClient({ room: FILM, cp: VERSION, name: 'H2' });
    await h2.ready;
    const hb = await h2.waitFor((m) => m.type === 'history', 'baseline after cached-frame layer change');
    assert.ok(!hb.checkpoint || !hb.checkpoint.frames.some((fr) => fr.frameId === f0),
      'cached frame dropped after ITS layer stack changed');
    assert.ok(hb.checkpoint && hb.checkpoint.frames.some((fr) => fr.frameId === f2),
      'the untouched frame keeps its checkpoint (per-frame invalidation)');
    h1.close(); h2.close();
  });

  // -- 8: frame clear invalidates -----------------------------------------------------
  await scenario('frame clear (content generation) invalidates the checkpoint', async () => {
    film.host.send({ type: 'clear', frameId: f0 });
    await sleep(400);
    const j = new CpClient({ room: FILM, cp: VERSION, name: 'postclear' });
    await j.ready;
    const h = await j.waitFor((m) => m.type === 'history', 'post-clear history');
    assert.ok(!h.checkpoint || !h.checkpoint.frames.some((fr) => fr.frameId === f0),
      'cleared frame never served from cache');
    assert.ok(h.ops.every((op) => op.frameId !== f0), 'cleared frame ops gone from the baseline');
    j.close();
  });

  // -- 9: restart: full preservation + lazy rebuild -----------------------------------
  await scenario('server restart: early frames/ops fully preserved, memory-only cache rebuilds lazily', async () => {
    film.host.close();
    await killServer(boot);
    boot = bootServer({
      ENABLE_TRUSTED_CHECKPOINTS: '1',
      CHECKPOINT_CHROME_PATH: CHROME,
      CHECKPOINT_MIN_OPS: '4',
      CHECKPOINT_FRAME_MIN_OPS: '2',
      CHECKPOINT_REBUILD_TAIL: '100000',
      CHECKPOINT_JOB_TIMEOUT_MS: '60000',
    }, { keepData: true });
    await waitHealth();
    const m0 = await metrics();
    assert.equal(m0.entries, 0, 'memory-only cache is empty after restart');

    // A legacy (text) join replays the whole scene: early frames intact.
    const legacy = new CpClient({ room: FILM, gz: false, name: 'legacy' });
    await legacy.ready;
    const h = await legacy.waitFor((m) => m.type === 'history', 'legacy scene history');
    const frameIds = h.frames.map((f) => f.id);
    assert.ok(frameIds.includes(f2) && frameIds.includes(f3), 'early frames preserved (never front-trimmed)');
    assert.ok(h.ops.some((op) => op.frameId === f2) && h.ops.some((op) => op.frameId === f3),
      'early frame art retained across restart');
    assert.ok(h.ops.every((op) => op.frameId !== f0), 'the cleared frame stays cleared');

    // Capable join: ordinary first, then the requested frame's checkpoint
    // rebuilds lazily (f0 was cleared above — it can never checkpoint, so ask
    // for f2 exactly like a client paging to it would).
    const cold = new CpClient({ room: FILM, cp: VERSION, name: 'restart-cold' });
    await cold.ready;
    const hc = await cold.waitFor((m) => m.type === 'history', 'post-restart baseline');
    assert.ok(!hc.checkpoint, 'no checkpoint from a cold cache');
    const mark = cold.mark();
    cold.send({ type: 'scene_fetch', sceneId: scene1, frameId: f2 });
    await cold.waitFor((m) => m.type === 'history', 'f2 fetch', 12000, mark);
    await waitMetric((m) => m.builds >= 1, 'lazy rebuild after restart');
    legacy.close(); cold.close();
  });

  // -- 10: legacy no-cp animation client --------------------------------------------
  await scenario('legacy (no cp) animation client: ordinary scene history, no checkpoint key', async () => {
    const plain = new CpClient({ room: FILM, name: 'plain' });
    await plain.ready;
    const h = await plain.waitFor((m) => m.type === 'history', 'plain scene history');
    assert.ok(!h.checkpoint, 'no checkpoint key for legacy clients');
    assert.equal(h.sceneId, scene1);
    plain.close();
  });

  await killServer(boot);

  // -- 11: flag off -------------------------------------------------------------------
  await scenario('flag off: animation rooms behave exactly as before (no builds, no checkpoint)', async () => {
    boot = bootServer({ CHECKPOINT_CHROME_PATH: CHROME, CHECKPOINT_MIN_OPS: '4', CHECKPOINT_FRAME_MIN_OPS: '2' });
    try {
      await waitHealth();
      const m = await metrics();
      assert.equal(m.enabled, false);
      assert.equal(m.reason, 'flag_off');
      const OFF = room('ZOF');
      const host = new CpClient({ room: OFF, name: 'offhost' });
      await host.ready;
      host.send({ type: 'set_animation', enabled: true });
      await host.waitFor((x) => x.type === 'room_animation' && x.enabled === true, 'animation on');
      host.sendOp(stroke(60, '#112211', [[100, 100], [300, 300]]));
      host.sendOp(stroke(61, '#221122', [[400, 400], [600, 600]]));
      await sleep(400);
      const j = new CpClient({ room: OFF, cp: VERSION, name: 'offjoin' });
      await j.ready;
      const h = await j.waitFor((x) => x.type === 'history', 'flag-off scene history');
      assert.ok(!h.checkpoint && h.ops.length === 2, 'ordinary scene history with the flag off');
      const m2 = await metrics();
      assert.equal(m2.builds, 0, 'no builds with the flag off');
      host.close(); j.close();
    } finally {
      await killServer(boot);
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
