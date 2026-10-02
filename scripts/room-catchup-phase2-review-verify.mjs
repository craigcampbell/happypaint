// Phase-2 INDEPENDENT REVIEW regression suite (room-loading, server-side only).
// Covers the gaps the phase-2 suite does not:
//
//   Part F  (unit)  phase-3 seam: createCatchup must export runCatchup /
//                   isCurrent / sendFresh; the seam gates, orders and flushes.
//   Part G  (unit)  catch-up gate queue accounts BYTES (UTF-8), not UTF-16
//                   string length, a multibyte payload trips the byte bound.
//   Part H  (unit)  historyFrame freezes nested metadata: a layer/stack
//                   mutation landing MID-BUILD must not tear the frame bytes.
//   Part I  (:19111) a rate-limited scene_fetch is answered EXPLICITLY
//                   (resync retry signal), never silently dropped while the
//                   client holds a scene waiter.
//   Part J  (:19111) a scene DELETED during its in-flight fetch: the fetcher
//                   still gets a baseline + the scene_del, in order, alive.
//   Part K  (:19112) bounded outgoing queues: durable broadcasts to a stalled
//                   socket are queued reliably (nothing lost, order kept)
//                   while ephemeral cursors may drop under backpressure.
//   Part L  (:19113) durable overflow of the outgoing queue disconnects the
//                   stalled socket with 1013 (resync), never silent loss.
//
// Isolated scratch DATA_DIRs, no auth/billing, snapshots off. Run with
//   node scripts/room-catchup-phase2-review-verify.mjs
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { SimClient } from '../test/harness/client.mjs';
import { createCatchup } from '../server/catchup.js';
import { buildGzippedHistoryFrame } from '../server/historyFrame.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_ROOT = process.env.PHASE2_SCRATCH
  || (process.env.TMPDIR ? join(process.env.TMPDIR, 'room-backend-phase2-review') : '/tmp/room-backend-phase2-review');
mkdirSync(SCRATCH_ROOT, { recursive: true });
const ADMIN_KEY = 'isolated-phase2-review';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
let assertions = 0;
function check(name, value, detail = '') {
  assertions += 1;
  assert.ok(value, `${name}${detail ? `, ${detail}` : ''}`);
  console.log(`  PASS ${name}`);
}
async function part(name, fn) {
  process.stdout.write(`PART ${name}: `);
  try {
    await fn();
    results.push({ part: name, ok: true });
    console.log(`PART ${name} OK`);
  } catch (err) {
    results.push({ part: name, ok: false, error: String(err && err.message || err) });
    console.log(`PART ${name} FAIL, ${err && err.message}`);
  }
}

function drawOp(strokeId, i, points = 1) {
  const pts = [];
  for (let p = 0; p < points; p += 1) pts.push({ x: 10 + (i % 100) + p * 0.5, y: 20 + p * 0.25, pressure: 0.5 });
  return { kind: 'draw', strokeId, end: true, points: pts, settings: { brush: 'marker', size: 10, color: '#123456', opacity: 1 } };
}

async function startServer({ port, env = {}, scratch }) {
  mkdirSync(scratch, { recursive: true });
  const wrapper = join(scratch, `fixture-${port}-${Date.now()}.mjs`);
  writeFileSync(wrapper, `
    process.on('message', (message) => {
      if (message.type === 'signal') process.emit(message.signal || 'SIGTERM');
    });
    await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server.js')).href)});
  `);
  let logs = '';
  const child = fork(wrapper, [], {
    cwd: ROOT, silent: true, windowsHide: true,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: scratch,
      ROOM_DIR: join(scratch, '.rooms'), ARTWORK_DIR: join(scratch, '.artworks'),
      CHAT_LOG_DIR: join(scratch, '.chatlog'), PB_URL: '', POCKETBASE_URL: '',
      ADMIN_KEY, AUTO_CLOSE: 'off',
      STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_CHECKOUT_ENABLED: 'false',
      ENABLE_CLIENT_SNAPSHOTS: '',
      ...env,
    },
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const exited = once(child, 'exit');
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ }
    if (ready) break;
    if (child.exitCode !== null) throw new Error(`server on :${port} failed to start: ${logs}`);
    await sleep(40);
  }
  assert.ok(ready, `server ready on :${port}`);
  const clients = [];
  const connect = async (room, opts = {}) => {
    const client = new SimClient(`ws://127.0.0.1:${port}`, { room, ...opts });
    clients.push(client);
    await client.connect({ timeoutMs: opts.connectTimeoutMs || 8000 });
    return client;
  };
  const stop = async () => {
    for (const client of clients) client.ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  return { base, connect, stop, logs: () => logs, clients };
}

async function sendBurst(client, n, prefix, { points = 1, burst = 10, pauseMs = 30, start = 0, frameId = null } = {}) {
  for (let i = 0; i < n; i += 1) {
    const op = drawOp(`${prefix}-${start + i}`, start + i, points);
    if (frameId) op.frameId = frameId;
    client.sendOp(op);
    if (i % burst === burst - 1) await sleep(pauseMs);
  }
}
async function setupAnimationRoom(host, extraScenes) {
  host.send({ type: 'set_animation', enabled: true });
  await host.waitFor((m) => m.type === 'room_animation' && m.enabled === true, { timeoutMs: 4000, label: 'room_animation on' });
  const scenes = [{ sceneId: 's0', frameId: 'f0' }];
  const seen = new Set(['s0']);
  for (let i = 0; i < extraScenes; i += 1) {
    host.send({ type: 'scene_add' });
    const added = await host.waitFor((m) => m.type === 'scene_add' && m.scene && !seen.has(m.scene.id), { timeoutMs: 4000, label: 'scene_add echo' });
    seen.add(added.scene.id);
    host.send({ type: 'scene_fetch', sceneId: added.scene.id });
    const h = await host.waitFor((m) => m.type === 'history' && m.sceneId === added.scene.id, { timeoutMs: 4000, label: 'new scene history' });
    scenes.push({ sceneId: added.scene.id, frameId: h.frames[0].id });
  }
  return scenes;
}

const CACHE_ENV = {
  HISTORY_CACHE_MIN_OPS: '100', HISTORY_CACHE_TAIL_MAX: '60', HISTORY_CACHE_PREBUILD_TAIL: '0',
  HISTORY_CACHE_BUILD_BUDGET_MS: '1', SCENE_CACHE_MIN_OPS: '100',
  OP_RATE_PER_SEC: '100000', OP_RATE_BURST: '2000000',
};

// ---- Fakes for the unit parts ------------------------------------------------
function fakeDeps(configOverrides = {}) {
  const rooms = new Map();
  const room = {
    code: 'FAKE', history: [], hiddenOpIds: new Set(), hiddenGen: 0, historyGen: 0,
    frames: [{ id: 'f0', durationMs: 120, sceneId: 's0', layers: [] }],
    opSeq: 0, frameOpCounts: new Map(),
  };
  rooms.set(room.code, room);
  const deps = {
    rooms,
    config: {
      HISTORY_CACHE_MIN_OPS: 100, HISTORY_CACHE_TAIL_MAX: 60, HISTORY_CACHE_BUILD_BUDGET_MS: 1,
      SCENE_CACHE_MIN_OPS: 100, SCENE_CACHE_MAX_ENTRIES: 8, SCENE_CACHE_MAX_BYTES: 1 << 20,
      CATCHUP_QUEUE_MAX_MESSAGES: 1024, CATCHUP_QUEUE_MAX_BYTES: 4096,
      ...configOverrides,
    },
    visibleHistory: (r) => r.history,
    historyMessageFor: (r) => ({ type: 'history', ops: r.history, frames: r.frames }),
    historyCacheUsable: () => false,
    historyTailAfter: () => null,
    buildHistoryCache: () => Promise.reject(new Error('no build in unit test')),
    sceneHistoryMsg: (r, sceneId) => ({ type: 'history', sceneId, ops: [], frames: [] }),
    scenesMeta: () => [],
    framesOfScene: (r, sceneId) => r.frames.filter((f) => f.sceneId === sceneId),
    opFrameId: (r, op) => op.frameId || 'f0',
    opIndexOf: () => -1,
  };
  return { deps, room, rooms };
}
function fakeWs() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closedWith: null,
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closedWith = { code, reason: String(reason || '') }; this.readyState = 3; },
  };
}

// ---- Part F: phase-3 seam exists and orders delivery (unit) ------------------
async function partF() {
  const { deps, room } = fakeDeps();
  const api = createCatchup(deps);
  check('F1 catchup exports the phase-3 seam (runCatchup / isCurrent / sendFresh)',
    typeof api.runCatchup === 'function' && typeof api.isCurrent === 'function' && typeof api.sendFresh === 'function',
    `got {${Object.keys(api)}}`);
  if (typeof api.runCatchup !== 'function') return;

  // The seam gates DURING an async deliverer, then flushes queued ops AFTER
  // the baseline, deduped against its watermark.
  const ws = fakeWs();
  await api.runCatchup(ws, room, { kind: 'full' }, async () => {
    await sleep(20); // async window: a live op broadcast lands mid-delivery
    const msg = { type: 'op', op: { opId: 5, frameId: 'f0' } };
    const gated = api.routeGatedBroadcast(ws, room, msg, JSON.stringify(msg));
    check('F2 live op is gated while the seam deliverer is in flight', gated === true);
    ws.send(JSON.stringify({ type: 'history', ops: [{ opId: 4 }] })); // baseline
    return { kind: 'frame', throughOpId: 4 };
  });
  check('F3 seam flushes the gated op exactly once, AFTER the baseline',
    ws.sent.length === 2
    && JSON.parse(ws.sent[0]).type === 'history'
    && JSON.parse(ws.sent[1]).type === 'op' && JSON.parse(ws.sent[1]).op.opId === 5,
    ws.sent.map((s) => JSON.parse(s).type).join(','));

  // sendFresh through the seam: complete current state + fresh outcome.
  const ws2 = fakeWs();
  const outcome = api.sendFresh(ws2, room, { kind: 'full' });
  check('F4 sendFresh delivers the complete state and reports a fresh outcome',
    ws2.sent.length === 1 && JSON.parse(ws2.sent[0]).type === 'history'
    && outcome && outcome.kind === 'fresh',
    `${ws2.sent.length} sends, outcome ${JSON.stringify(outcome)}`);

  // isCurrent: a superseded gate reports stale.
  const ws3 = fakeWs();
  const gate = api.beginGate(ws3);
  const epoch = gate.epoch;
  check('F5 isCurrent true for the live gate', api.isCurrent(ws3, gate, epoch) === true);
  api.beginGate(ws3); // supersede
  check('F6 isCurrent false after supersede', api.isCurrent(ws3, gate, epoch) === false);
}

// ---- Part G: gate queue byte accounting (unit) -------------------------------
async function partG() {
  // A payload whose UTF-8 BYTE length crosses the bound while its UTF-16
  // string length stays under it must overflow (1013), not queue.
  const payload = `🎨${'x'.repeat(118)}`; // 120 UTF-16 units, 123 UTF-8 bytes
  const message = { type: 'sheet', sheetId: payload };
  const data = JSON.stringify(message);
  const byteLen = Buffer.byteLength(data);
  check('G0 fixture: byte length exceeds string length', byteLen > data.length, `${data.length} chars vs ${byteLen} bytes`);
  const { deps, room } = fakeDeps({ CATCHUP_QUEUE_MAX_BYTES: data.length }); // fits chars exactly, not bytes
  const api = createCatchup(deps);
  const ws = fakeWs();
  api.beginGate(ws);
  api.routeGatedBroadcast(ws, room, message, data);
  check('G1 gate overflow is measured in BYTES, not UTF-16 length',
    ws.closedWith && ws.closedWith.code === 1013,
    `closedWith ${JSON.stringify(ws.closedWith)}, queued bytes ${ws.catchup ? ws.catchup.bytes : 'gate dropped'}`);

  // ...and a payload that fits in bytes queues with BYTE-accurate accounting.
  const { deps: deps2, room: room2 } = fakeDeps({ CATCHUP_QUEUE_MAX_BYTES: byteLen + 8 });
  const api2 = createCatchup(deps2);
  const ws2 = fakeWs();
  const gate2 = api2.beginGate(ws2);
  api2.routeGatedBroadcast(ws2, room2, message, data);
  check('G2 queued entry accounts UTF-8 bytes', gate2.bytes === byteLen, `${gate2.bytes} accounted vs ${byteLen} bytes`);
}

// ---- Part H: history frame freezes nested metadata (unit) --------------------
async function partH() {
  const ops = [];
  for (let i = 0; i < 8000; i += 1) ops.push({ ...drawOp(`h-${i}`, i, 5), opId: i + 1, frameId: 'f0' });
  const frames = [{ id: 'f0', durationMs: 120, sceneId: 's0', layers: [{ id: 'L0', name: 'Layer 1', visible: true, opacity: 1, locked: false }] }];
  const msg = { type: 'history', ops, frames };
  // The expected bytes: the message as frozen at call time (one layer).
  const expected = JSON.stringify({ type: 'history', ops, frames });
  const build = buildGzippedHistoryFrame({ variant: 'full', gen: 1, hiddenGen: 0, framesKey: 'k', msg, budgetMs: 1 });
  // Mutate the LIVE nested metadata mid-build (an add+remove pair of structural
  // edits can leave the invalidation key unchanged, the bytes must still be
  // the frozen snapshot, never a torn old/new mix).
  setTimeout(() => {
    frames[0].layers.push({ id: 'L9', name: 'TEAR', visible: true, opacity: 1, locked: false });
  }, 2);
  const built = await build;
  const text = gunzipSync(built.gz).toString('utf8');
  check('H1 frame bytes are the FROZEN metadata snapshot (no mid-build tear)',
    text === expected,
    text === expected ? '' : `layers in output: ${(text.match(/"L[0-9]"/g) || []).join(',')}`);
}

// ---- Part I: rate-limited scene_fetch is answered explicitly (:19111) ---------
async function partI(srv) {
  const host = await srv.connect('ZZRL');
  const [sA, sB] = await setupAnimationRoom(host, 1);
  await sendBurst(host, 120, 'ia', { points: 30, pauseMs: 10, frameId: sA.frameId });
  await sendBurst(host, 120, 'ib', { points: 30, pauseMs: 10, frameId: sB.frameId });
  await sleep(400);
  const member = await srv.connect('ZZRL', { gz: true });
  await member.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'member join' });
  // Wait for the Nth history by COUNT, a sceneId-only predicate would match a
  // stale buffered frame from an earlier fetch and clear the waiter early.
  let expectedHistories = 1; // the join baseline
  for (const sceneId of [sB.sceneId, sA.sceneId, sB.sceneId]) { // 3 tokens
    expectedHistories += 1;
    member.send({ type: 'scene_fetch', sceneId });
    const want = expectedHistories;
    await member.waitFor((m) => m.type === 'history' && m.sceneId === sceneId && member.all('history').length >= want,
      { timeoutMs: 8000, label: `fetch ${sceneId} (history #${want})` });
  }
  member.messages.length = 0;
  member.send({ type: 'scene_fetch', sceneId: sB.sceneId }); // 4th: over the limit
  const resync = await member.waitFor((m) => m.type === 'resync', { timeoutMs: 4000, label: 'rate-limit resync' });
  check('I1 a rate-limited scene_fetch gets an EXPLICIT resync (no silent waiter hang)', !!resync);
  await sleep(600);
  check('I2 no history answer is fabricated for the dropped fetch',
    !member.messages.some((m) => m.type === 'history'), `${member.all('history').length} histories`);
  check('I3 the rate-limited member stays connected', !member.closed);
}

// ---- Part J: scene deleted mid-fetch stays ordered + live (:19111) ------------
async function partJ(srv) {
  const host = await srv.connect('ZZDEL');
  const [sA, sB] = await setupAnimationRoom(host, 1);
  await sendBurst(host, 400, 'jb', { points: 60, pauseMs: 8, frameId: sB.frameId });
  await sleep(400);
  const member = await srv.connect('ZZDEL', { gz: true });
  await member.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'member join' });
  member.messages.length = 0;
  member.send({ type: 'scene_fetch', sceneId: sB.sceneId });
  host.send({ type: 'scene_del', sceneId: sB.sceneId }); // lands mid-build
  const historyB = await member.waitFor((m) => m.type === 'history' && m.sceneId === sB.sceneId, { timeoutMs: 10000, label: 'scene B baseline' });
  const del = await member.waitFor((m) => m.type === 'scene_del' && m.sceneId === sB.sceneId, { timeoutMs: 8000, label: 'scene_del' });
  check('J1 deleting a scene mid-fetch still delivers a baseline AND the scene_del', !!historyB && !!del);
  const historyIndex = member.messages.indexOf(historyB);
  const delIndex = member.messages.indexOf(del);
  check('J2 the baseline precedes the scene_del (no stale structure after it)', historyIndex >= 0 && delIndex > historyIndex,
    `history@${historyIndex} del@${delIndex}`);
  const opIds = new Set();
  let dupes = 0;
  for (const m of member.messages) {
    if (m.type === 'history') for (const op of m.ops || []) { if (opIds.has(op.opId)) dupes += 1; opIds.add(op.opId); }
    if (m.type === 'op' && m.op) { if (opIds.has(m.op.opId)) dupes += 1; opIds.add(m.op.opId); }
  }
  check('J3 no op is delivered twice across the deletion race', dupes === 0, `${dupes} dupes`);
  check('J4 the fetcher survives the deletion race', !member.closed);
  member.messages.length = 0;
  member.send({ type: 'scene_fetch', sceneId: sA.sceneId });
  const historyA = await member.waitFor((m) => m.type === 'history' && m.sceneId === sA.sceneId, { timeoutMs: 8000, label: 'scene A refetch' });
  check('J5 remaining scenes fetch cleanly afterwards', !!historyA);
}

// ---- Part K: bounded outgoing queue, durable reliable, ephemeral maydrop ----
// A stalled (paused) consumer: durable ops must ALL arrive in order once the
// socket drains (queued, never silently discarded); ephemeral cursors under
// backpressure may be dropped instead of growing memory.
async function partK(srv) {
  const painter = await srv.connect('ZZSLOWK');
  const slow = await srv.connect('ZZSLOWK');
  await slow.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'slow join history' });
  // Stall the consumer and shrink its receive window so backpressure reaches
  // the server's ws layer quickly.
  try { slow.ws._socket.setRecvBufferSize(2048); } catch { /* older Node: flood still covers it */ }
  slow.ws._socket.pause();
  await sleep(200);
  const OPS = 400; // ~1.4MB of durable traffic: far past kernel buffers
  for (let i = 0; i < OPS; i += 1) {
    painter.sendOp(drawOp(`k-${i}`, i, 80));
    if (i % 40 === 39) await sleep(15);
  }
  const CURSORS = 300;
  for (let i = 0; i < CURSORS; i += 1) painter.send({ type: 'cursor', x: i % 100, y: i % 100, drawing: false });
  const MORE = 40;
  for (let i = 0; i < MORE; i += 1) painter.sendOp(drawOp(`k-tail-${i}`, OPS + i, 80));
  await sleep(500);
  check('K1 a stalled socket under the durable queue bound is NOT disconnected',
    !slow.closed, `closed=${slow.closed} code=${slow.closeInfo && slow.closeInfo.code}`);
  slow.messages.length = 0;
  slow.ws._socket.resume();
  await slow.waitFor((m) => m.type === 'op' && m.op && m.op.strokeId === `k-tail-${MORE - 1}`, { timeoutMs: 20000, label: 'final queued op' });
  await sleep(400);
  const gotOps = slow.messages.filter((m) => m.type === 'op').map((m) => m.op);
  const ids = gotOps.map((o) => o.opId);
  let ordered = ids.length === OPS + MORE;
  for (let i = 0; i < ids.length && ordered; i += 1) ordered = ids[i] === i + 1;
  check('K2 EVERY durable op survived the stall, exactly once and in order',
    ordered, `${ids.length}/${OPS + MORE} ops, first ${ids[0]}, last ${ids[ids.length - 1]}`);
  const gotCursors = slow.messages.filter((m) => m.type === 'cursor').length;
  check('K3 ephemeral cursors under backpressure may drop (never queue unbounded)',
    gotCursors < CURSORS, `${gotCursors}/${CURSORS} cursors arrived`);
}

// ---- Part L: durable outgoing overflow disconnects (1013) (:19113) ------------
async function partL(srv) {
  const painter = await srv.connect('ZZSLOWL');
  const slow = await srv.connect('ZZSLOWL');
  await slow.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'slow join history' });
  try { slow.ws._socket.setRecvBufferSize(2048); } catch { /* ignore */ }
  slow.ws._socket.pause();
  await sleep(200);
  for (let i = 0; i < 400 && !slow.closed; i += 1) {
    painter.sendOp(drawOp(`l-${i}`, i, 80));
    if (i % 40 === 39) await sleep(15);
  }
  await sleep(1500);
  slow.ws._socket.resume();
  await new Promise((resolvePromise) => {
    if (slow.closed) { resolvePromise(); return; }
    slow.ws.once('close', resolvePromise);
    setTimeout(resolvePromise, 8000);
  });
  check('L1 durable overflow of the outgoing queue disconnects with 1013 (resync, not silent loss)',
    slow.closed && slow.closeInfo && slow.closeInfo.code === 1013,
    `closed=${slow.closed} code=${slow.closeInfo && slow.closeInfo.code}`);
}

const scratchI = mkdtempSync(join(SCRATCH_ROOT, 'review-main-'));
const scratchK = mkdtempSync(join(SCRATCH_ROOT, 'review-slow-'));
const scratchL = mkdtempSync(join(SCRATCH_ROOT, 'review-over-'));

await part('F phase-3 seam (unit)', partF);
await part('G gate byte accounting (unit)', partG);
await part('H frame metadata freeze (unit)', partH);

const srvI = await startServer({
  port: 19111, scratch: scratchI,
  env: { ...CACHE_ENV, SCENE_FETCH_MAX: '3', SCENE_FETCH_WINDOW_MS: '30000' },
});
try {
  await part('I rate-limited scene_fetch answered', () => partI(srvI));
  await part('J scene deleted mid-fetch', () => partJ(srvI));
} finally {
  await srvI.stop();
}
const srvK = await startServer({
  port: 19112, scratch: scratchK,
  env: {
    ...CACHE_ENV,
    WS_SEND_SOFT_LIMIT_BYTES: '1024', WS_SEND_QUEUE_MAX_MESSAGES: '4096', WS_SEND_QUEUE_MAX_BYTES: String(16 * 1024 * 1024),
  },
});
try {
  await part('K durable reliable / ephemeral maydrop', () => partK(srvK));
} finally {
  await srvK.stop();
}
const srvL = await startServer({
  port: 19113, scratch: scratchL,
  env: {
    ...CACHE_ENV,
    WS_SEND_SOFT_LIMIT_BYTES: '1024', WS_SEND_QUEUE_MAX_MESSAGES: '64', WS_SEND_QUEUE_MAX_BYTES: String(32 * 1024),
  },
});
try {
  await part('L durable outgoing overflow -> 1013', () => partL(srvL));
} finally {
  await srvL.stop();
}

for (const dir of [scratchI, scratchK, scratchL]) rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\nroom-catchup-phase2-review-verify: ${assertions} assertions, ${results.length - failed.length}/${results.length} parts passed`);
if (failed.length) {
  console.log(`FAILED PARTS: ${failed.map((f) => `${f.part} (${f.error})`).join('; ')}`);
  process.exit(1);
}
