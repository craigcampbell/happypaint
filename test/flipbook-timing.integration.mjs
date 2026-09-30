/* eslint-env node */
// Phase-4 FLIPBOOK frame timing — raw-WS server integration.
//
// Contract (PHASE4-CONTRACT.md "Timing handshake"):
//  - `connected.frameTiming = {minMs,maxMs,defaultMs}`: EXACTLY
//    {1000,3000,1000} for room code FLIPBOOK, {40,10000,120} everywhere else
//    (public, private animation, local defaults unchanged);
//  - the server ENFORCES the FLIPBOOK 1–3s hold on new frames, duplicated
//    frames, frame_duration messages and persisted frame loads — malicious
//    values (1ms, 30s, NaN junk) clamp into range;
//  - `room_animation` broadcasts carry frameTiming when the mode changes;
//  - a legacy persisted FLIPBOOK film with out-of-range holds is normalized
//    by the server's canonical meta on load;
//  - actor permissions are unchanged: scene_add stays host-only, a locked
//    room's non-host frame_duration is still refused.
//
//   node test/flipbook-timing.integration.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = '/home/craig/.hermes/cache/scratch/phase4backend/flipbook-timing';
const PORT = 19132;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(room, name = 'c') {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${room}`);
    this.messages = [];
    this.label = name;
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.messages.push(msg);
    });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: connect timeout`)), 8000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ type: 'auth', token: null })));
      this.ws.on('message', (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === 'connected') { clearTimeout(timer); resolve(m); }
        } catch { /* ignore */ }
      });
      this.ws.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  async waitFor(test, label, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(test);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`${this.label}: timeout waiting for ${label}`);
      await sleep(50);
    }
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// ---- server boot -------------------------------------------------------------
function bootServer(extraEnv = {}, { keepData = false } = {}) {
  const dataDir = path.join(SCRATCH, 'data');
  if (!keepData) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, PB_URL: '', NODE_ENV: 'test', ...extraEnv },
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

const FLIPBOOK_TIMING = { minMs: 1000, maxMs: 3000, defaultMs: 1000 };
const ORDINARY_TIMING = { minMs: 40, maxMs: 10000, defaultMs: 120 };
const assertTiming = (actual, expected, what) => {
  assert.ok(actual && typeof actual === 'object', `${what}: frameTiming present`);
  assert.deepEqual(
    { minMs: actual.minMs, maxMs: actual.maxMs, defaultMs: actual.defaultMs },
    expected,
    `${what}: exact frameTiming contract`,
  );
};

let boot = bootServer();

async function main() {
  await waitHealth();
  console.log('server healthy on', PORT);

  // -- 1: FLIPBOOK handshake + enforced holds ---------------------------------
  await scenario('FLIPBOOK: handshake 1000/3000/1000 + enforced holds on add/duration', async () => {
    const a = new Client('FLIPBOOK', 'A');
    const connected = await a.ready;
    assertTiming(connected.frameTiming, FLIPBOOK_TIMING, 'FLIPBOOK connected');

    // New frame: server assigns the FLIPBOOK default hold, not 120ms.
    a.send({ type: 'frame_add' });
    const added = await a.waitFor((m) => m.type === 'frame_add', 'frame_add');
    assert.equal(added.frame.durationMs, 1000, 'new FLIPBOOK frame defaults to 1000ms');

    // Malicious / junk durations clamp into 1000..3000.
    const fid = added.frame.id;
    a.send({ type: 'frame_duration', frameId: fid, durationMs: 1 });
    let d = await a.waitFor((m) => m.type === 'frame_duration' && m.frameId === fid, 'duration 1ms');
    assert.equal(d.durationMs, 1000, '1ms clamps up to 1000');
    a.send({ type: 'frame_duration', frameId: fid, durationMs: 30000 });
    d = await a.waitFor((m) => m.type === 'frame_duration' && m.frameId === fid && m.durationMs !== 1000, 'duration 30s');
    assert.equal(d.durationMs, 3000, '30000ms clamps down to 3000 (never 30s a frame)');
    a.send({ type: 'frame_duration', frameId: fid, durationMs: 'junk' });
    d = await a.waitFor((m) => m.type === 'frame_duration' && m.frameId === fid && m.durationMs !== 3000, 'duration junk');
    assert.equal(d.durationMs, 1000, 'non-numeric falls back to the 1000ms default');
    a.send({ type: 'frame_duration', frameId: fid, durationMs: 1500 });
    d = await a.waitFor((m) => m.type === 'frame_duration' && m.frameId === fid && m.durationMs === 1500, 'duration 1500');
    assert.equal(d.durationMs, 1500, 'in-range values pass through');

    // Duplicate inherits the (in-range) source hold.
    a.send({ type: 'frame_add', duplicateOf: fid });
    const dup = await a.waitFor((m) => m.type === 'frame_add' && m.duplicateOf === fid, 'duplicate frame');
    assert.equal(dup.frame.durationMs, 1500, 'duplicate keeps the source hold');
    a.close();
  });

  // -- 2: MAIN (ordinary public room) timing unchanged -------------------------
  await scenario('MAIN: ordinary timing 40/10000/120 unchanged', async () => {
    const a = new Client('MAIN', 'M');
    const connected = await a.ready;
    assertTiming(connected.frameTiming, ORDINARY_TIMING, 'MAIN connected');
    a.close();
  });

  // -- 3: private animation room: ordinary timing, room_animation carries it ---
  await scenario('private animation room: 40/10000/120 + room_animation frameTiming + permissions', async () => {
    const roomId = `ZT${Math.floor(Math.random() * 900 + 100)}`;
    const host = new Client(roomId, 'host');
    const connected = await host.ready; // first joiner of a friends room = guest host
    assertTiming(connected.frameTiming, ORDINARY_TIMING, 'private room connected');

    host.send({ type: 'set_animation', enabled: true });
    const ra = await host.waitFor((m) => m.type === 'room_animation' && m.enabled === true, 'room_animation on');
    assertTiming(ra.frameTiming, ORDINARY_TIMING, 'room_animation broadcast');

    host.send({ type: 'frame_add' });
    const added = await host.waitFor((m) => m.type === 'frame_add', 'frame_add');
    assert.equal(added.frame.durationMs, 120, 'private animation new frame keeps the 120ms default');
    const fid = added.frame.id;
    host.send({ type: 'frame_duration', frameId: fid, durationMs: 1 });
    let d = await host.waitFor((m) => m.type === 'frame_duration' && m.frameId === fid, 'duration 1ms');
    assert.equal(d.durationMs, 40, 'private room floor stays 40ms');
    host.send({ type: 'frame_duration', frameId: fid, durationMs: 99999 });
    d = await host.waitFor((m) => m.type === 'frame_duration' && m.frameId === fid && m.durationMs !== 40, 'duration 99999');
    assert.equal(d.durationMs, 10000, 'private room ceiling stays 10000ms');

    // Permissions preserved: scene_add is host-only — a second member is denied.
    const guest = new Client(roomId, 'guest');
    await guest.ready;
    guest.send({ type: 'scene_add' });
    await sleep(400);
    assert.ok(!guest.messages.some((m) => m.type === 'scene_add'), 'non-host scene_add refused');

    // A locked room refuses a non-host frame_duration (actor guard unchanged).
    host.send({ type: 'lock', locked: true });
    await sleep(250);
    guest.send({ type: 'frame_duration', frameId: fid, durationMs: 500 });
    await sleep(400);
    assert.ok(!guest.messages.some((m) => m.type === 'frame_duration' && m.durationMs === 500),
      'locked room non-host frame_duration refused');
    host.close(); guest.close();
  });

  await killServer(boot);

  // -- 4: persisted legacy FLIPBOOK film normalized on load ---------------------
  await scenario('legacy persisted FLIPBOOK (120ms/99999ms frames) normalized to 1000..3000 on load', async () => {
    const dataDir = path.join(SCRATCH, 'data');
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dataDir, '.rooms'), { recursive: true });
    const layer = { id: 'L0', name: 'Layer 1', visible: true, opacity: 1, locked: false };
    fs.writeFileSync(path.join(dataDir, '.rooms', 'FLIPBOOK.json'), JSON.stringify({
      audience: 'kid_safe',
      animation: true,
      scenes: [{ id: 's1', name: 'Scene 1', loops: 1, camera: 'none' }],
      frames: [
        { id: 'f1', durationMs: 120, sceneId: 's1', layers: [layer] }, // legacy fast hold
        { id: 'f2', durationMs: 99999, sceneId: 's1', layers: [layer] }, // legacy slow hold
        { id: 'f3', durationMs: 2000, sceneId: 's1', layers: [layer] }, // already in range
      ],
      history: [
        { kind: 'draw', strokeId: 'lg1', userId: 'legacy', opId: 1, frameId: 'f1', settings: { brush: 'marker', color: '#123123', size: 24, opacity: 1, seed: 7 }, points: [{ x: 10, y: 10 }, { x: 60, y: 60 }], end: true },
      ],
    }));
    boot = bootServer({}, { keepData: true });
    try {
      await waitHealth();
      const a = new Client('FLIPBOOK', 'L');
      const connected = await a.ready;
      assertTiming(connected.frameTiming, FLIPBOOK_TIMING, 'legacy FLIPBOOK connected');
      const hist = await a.waitFor((m) => m.type === 'history', 'legacy history');
      const byId = new Map(hist.frames.map((f) => [f.id, f.durationMs]));
      assert.equal(byId.get('f1'), 1000, 'legacy 120ms normalized up to 1000');
      assert.equal(byId.get('f2'), 3000, 'legacy 99999ms normalized down to 3000');
      assert.equal(byId.get('f3'), 2000, 'in-range 2000ms preserved');
      assert.equal(hist.ops.length, 1, 'legacy art retained');
      a.close();
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
