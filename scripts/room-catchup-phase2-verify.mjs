// Phase-2 room-loading backend regression suite: scene-history gzip cache/index
// and ATOMIC gated catch-up (join / scene switch / modwatch / spectator).
//
//   Part A  (:19111) atomic join catch-up: ops appended DURING a cold gzip
//             build must arrive exactly once and only after the history frame
//             (member + homepage spectator scopes).
//   Part B  (:19111) scene cache: gz scene_fetch == legacy text message; one
//             shared in-flight build; warm hits; hide/restore/remove/clear/
//             layer/scene-metadata invalidation; concurrent joins; superseded
//             fetches never complete late; ops during a scene fetch arrive
//             exactly once (incl. other-scene ops); restart keeps scenes.
//   Part C  (:19112) bounded catch-up queue: overflow disconnects (1013), a
//             quiet rejoin then delivers the complete durable history.
//   Part D  (:19113) over-cap FILM load: a persisted multi-frame history above
//             a reduced MAX_ANIM_ROOM_OPS is NEVER front-trimmed; a single-frame
//             room above MAX_HISTORY still trims (guard unchanged). Restart too.
//   Part E  (:19114) scene_fetch storm rate limit; modwatch gz join + resync
//             refetch reflects moderation.
//
// Isolated: scratch DATA_DIR under the phase-2 scratch root, no auth/billing,
// ENABLE_CLIENT_SNAPSHOTS unset, no production data. Run with
//   node scripts/room-catchup-phase2-verify.mjs
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { SimClient } from '../test/harness/client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_ROOT = process.env.PHASE2_SCRATCH
  || (process.env.TMPDIR ? join(process.env.TMPDIR, 'room-backend-phase2') : '/tmp/room-backend-phase2');
mkdirSync(SCRATCH_ROOT, { recursive: true });
const ADMIN_KEY = 'isolated-phase2-test';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const results = [];
let assertions = 0;
function check(name, value, detail = '') {
  assertions += 1;
  assert.ok(value, `${name}${detail ? ` — ${detail}` : ''}`);
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
    console.log(`PART ${name} FAIL — ${err && err.message}`);
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
  const metrics = async () => (await fetch(`${base}/api/admin/metrics`, { headers: { 'x-admin-key': ADMIN_KEY } })).json();
  const stop = async () => {
    for (const client of clients) client.ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  return { base, connect, metrics, stop, logs: () => logs, clients };
}

const historyMsgsOf = (client) => client.messages.filter((m) => m.type === 'history');
const opsAfter = (client, historyMsg) => {
  const at = client.messages.indexOf(historyMsg);
  return client.messages.slice(at + 1).filter((m) => m.type === 'op').map((m) => m.op);
};
// Reconstruct what a joiner/fetcher ended up with: frame ops + later op messages.
function reconstructed(client, historyMsg) {
  return [...(historyMsg.ops || []), ...opsAfter(client, historyMsg)];
}
function assertExactlyOnce(name, ops) {
  const seen = new Set();
  const dupes = [];
  for (const op of ops) {
    if (seen.has(op.opId)) dupes.push(op.opId);
    seen.add(op.opId);
  }
  check(`${name}: every op delivered exactly once`, dupes.length === 0, `dupes ${dupes.slice(0, 8)}`);
}
async function sendBurst(client, n, prefix, { points = 1, burst = 10, pauseMs = 30, start = 0, frameId = null } = {}) {
  for (let i = 0; i < n; i += 1) {
    const op = drawOp(`${prefix}-${start + i}`, start + i, points);
    if (frameId) op.frameId = frameId;
    client.sendOp(op);
    if (i % burst === burst - 1) await sleep(pauseMs);
  }
}
// Keep painting until told to stop — returns the number of ops sent.
function paintUntil(stopRef, client, prefix, { everyMs = 3, start = 0, frameId = null } = {}) {
  let i = start;
  const tick = () => {
    if (stopRef.stop) return;
    const op = drawOp(`${prefix}-${i}`, i, 1);
    if (frameId) op.frameId = frameId;
    try { client.sendOp(op); } catch { stopRef.stop = true; return; }
    i += 1;
    setTimeout(tick, everyMs);
  };
  tick();
  return () => i;
}

// Enable animation on a private room (first member hosts it) and add scenes.
async function setupAnimationRoom(host, extraScenes) {
  host.send({ type: 'set_animation', enabled: true });
  await host.waitFor((m) => m.type === 'room_animation' && m.enabled === true, { timeoutMs: 4000, label: 'room_animation on' });
  const scenes = [{ sceneId: 's0', frameId: 'f0' }];
  const seen = new Set(['s0']);
  for (let i = 0; i < extraScenes; i += 1) {
    host.send({ type: 'scene_add' });
    // Match the echo for the NEW scene only — a buffered earlier echo would
    // otherwise satisfy this waiter instantly and collapse two scenes into one.
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

// ---- Part A: atomic join catch-up (member + spectator), port 19111 ----------
async function partA(srv) {
  // Non-animation room, cold cache, painter appends through the join build.
  const painter = await srv.connect('ZZRACE');
  await sendBurst(painter, 400, 'a', { points: 40, pauseMs: 15 });
  await sleep(400);

  const stopRef = { stop: false };
  const joiner = await srv.connect('ZZRACE', { gz: true });
  stopRef.stop = false;
  paintUntil(stopRef, painter, 'race', { everyMs: 3, start: 0 });
  const historyMsg = await joiner.waitFor((m) => m.type === 'history', { timeoutMs: 20000, label: 'gated history frame' });
  await sleep(600);
  stopRef.stop = true;
  await sleep(150);

  const firstOpIndex = joiner.messages.findIndex((m) => m.type === 'op');
  const historyIndex = joiner.messages.indexOf(historyMsg);
  check('A1 no live op arrives before the join history frame', firstOpIndex === -1 || historyIndex < firstOpIndex,
    `history@${historyIndex} firstOp@${firstOpIndex}`);
  check('A2 join history is ONE gz binary frame', joiner.binaryFrames === 1, `${joiner.binaryFrames} binary frames`);
  assertExactlyOnce('A3 member join stream', reconstructed(joiner, historyMsg));
  check('A4 no snapshot frames (ENABLE_CLIENT_SNAPSHOTS stays off)',
    !joiner.messages.some((m) => m.type === 'snapshot'));

  await sleep(400);
  const legacy = await srv.connect('ZZRACE');
  const legacyHistory = await legacy.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'legacy history' });
  const legacyOps = legacyHistory.ops;
  const rebuilt = reconstructed(joiner, historyMsg);
  assert.deepStrictEqual(rebuilt, legacyOps.slice(0, rebuilt.length));
  check('A5 member stream == legacy full history prefix (order + content)', true,
    `${rebuilt.length}/${legacyOps.length} ops`);

  // Spectator scope: homepage viewer on MAIN (public, listed) mid-paint.
  const mainPainter = await srv.connect('MAIN');
  await sendBurst(mainPainter, 300, 'm', { points: 40, pauseMs: 15 });
  await sleep(400);
  const specStop = { stop: false };
  const spectator = await srv.connect('MAIN', { gz: true, spectate: true });
  await spectator.waitFor((m) => m.type === 'connected', { timeoutMs: 5000, label: 'spectator connected' });
  paintUntil(specStop, mainPainter, 'spec', { everyMs: 3, start: 0 });
  const specHistory = await spectator.waitFor((m) => m.type === 'history', { timeoutMs: 20000, label: 'spectator history' });
  await sleep(500);
  specStop.stop = true;
  await sleep(150);
  const specFirstOp = spectator.messages.findIndex((m) => m.type === 'op');
  check('A6 no live op reaches a spectator before its history frame',
    specFirstOp === -1 || spectator.messages.indexOf(specHistory) < specFirstOp,
    `history@${spectator.messages.indexOf(specHistory)} firstOp@${specFirstOp}`);
  assertExactlyOnce('A7 spectator stream', reconstructed(spectator, specHistory));
}

// ---- Part B: scene cache + ordered scene delivery, port 19111 ---------------
async function partB(srv) {
  const host = await srv.connect('ZZANIM');
  const [sceneA, sceneB] = await setupAnimationRoom(host, 1);
  await sendBurst(host, 250, 'sa', { points: 40, pauseMs: 15, frameId: sceneA.frameId });
  await sendBurst(host, 250, 'sb', { points: 40, pauseMs: 15, frameId: sceneB.frameId });
  await sleep(500);

  // Legacy (text) scene fetch — the reference payload.
  const legacy = await srv.connect('ZZANIM');
  legacy.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const legacyB = await legacy.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId, { timeoutMs: 8000, label: 'legacy scene B' });
  check('B1 legacy scene_fetch stays plain text', legacy.binaryFrames === 0);

  // gz scene fetch — the cached binary frame path.
  const gz = await srv.connect('ZZANIM', { gz: true });
  gz.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const gzB = await gz.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId, { timeoutMs: 8000, label: 'gz scene B' });
  const gzFetchFrames = gz.binaryFrames;
  check('B2 gz scene_fetch is served as a binary frame', gzFetchFrames >= 1, `${gzFetchFrames} binary frames`);
  assert.deepStrictEqual(gzB.ops, legacyB.ops);
  assert.deepStrictEqual(gzB.frames, legacyB.frames);
  assert.deepStrictEqual(gzB.scenes, legacyB.scenes);
  check('B3 gz frame decodes to the EXACT legacy text message (ops/frames/scenes)', true);

  // Warm fetch: second gz fetcher must hit the shared entry, not rebuild.
  // (Snapshot metrics AFTER the first gz fetch built the entry.)
  const before = await srv.metrics();
  const gz2 = await srv.connect('ZZANIM', { gz: true });
  gz2.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  await gz2.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId, { timeoutMs: 8000, label: 'gz2 scene B' });
  const after = await srv.metrics();
  check('B4 warm scene fetch is a cache HIT (no rescan/rebuild)',
    after.catchup && after.catchup.sceneHits > (before.catchup ? before.catchup.sceneHits : 0)
    && after.catchup.sceneBuilds === (before.catchup ? before.catchup.sceneBuilds : 0),
    `metrics.catchup ${JSON.stringify(after.catchup || null)}`);

  // Two concurrent cold joins share ONE in-flight scene build.
  const host2 = await srv.connect('ZZJOIN2');
  await setupAnimationRoom(host2, 0);
  await sendBurst(host2, 250, 'j', { points: 40, pauseMs: 15, frameId: 'f0' });
  await sleep(400);
  const buildsBefore = (await srv.metrics()).catchup?.sceneBuilds ?? -1;
  const joiners = await Promise.all(Array.from({ length: 4 }, () => srv.connect('ZZJOIN2', { gz: true })));
  await Promise.all(joiners.map((j) => j.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'concurrent join history' })));
  const buildsAfter = (await srv.metrics()).catchup?.sceneBuilds ?? -1;
  check('B5 four concurrent cold joins share ONE in-flight scene build', buildsBefore >= 0 && buildsAfter - buildsBefore === 1,
    `builds ${buildsBefore} -> ${buildsAfter}`);
  const firstJoinOps = historyMsgsOf(joiners[0])[0].ops;
  check('B6 every concurrent joiner got the identical complete scene',
    joiners.every((j) => JSON.stringify(historyMsgsOf(j)[0].ops) === JSON.stringify(firstJoinOps) && firstJoinOps.length === 250),
    `${firstJoinOps.length} ops`);

  // Moderation / structure invalidation of the scene cache. (Messages are
  // cleared before each refetch so a stale buffered frame can't satisfy the
  // waiter early.)
  const hiddenId = legacyB.ops[10].opId;
  host.modHide([hiddenId]);
  await sleep(300);
  gz2.messages.length = 0;
  gz2.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const afterHide = await gz2.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId && m.ops.length < 250, { timeoutMs: 8000, label: 'post-hide scene B' });
  check('B7 hidden op drops out of the cached scene frame', !afterHide.ops.some((o) => o.opId === hiddenId));
  host.modRestore([hiddenId]);
  await sleep(300);
  gz2.messages.length = 0;
  gz2.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const afterRestore = await gz2.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId && m.ops.length === 250, { timeoutMs: 8000, label: 'post-restore scene B' });
  check('B8 restored op returns to the cached scene frame', afterRestore.ops.some((o) => o.opId === hiddenId));
  host.modRemove([hiddenId]);
  await sleep(300);
  gz2.messages.length = 0;
  gz2.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const afterRemove = await gz2.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId && m.ops.length === 249, { timeoutMs: 8000, label: 'post-remove scene B' });
  check('B9 removed op never comes back', !afterRemove.ops.some((o) => o.opId === hiddenId));

  host.send({ type: 'layer_add', frameId: sceneB.frameId });
  await host.waitFor((m) => m.type === 'layer_add', { timeoutMs: 4000, label: 'layer_add echo' });
  gz2.messages.length = 0;
  gz2.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const afterLayer = await gz2.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId && m.frames[0].layers.length === 2, { timeoutMs: 8000, label: 'post-layer scene B' });
  check('B10 layer metadata change invalidates the scene frame', afterLayer.frames[0].layers.length === 2);

  host.send({ type: 'scene_set', sceneId: sceneB.sceneId, loops: 3 });
  await host.waitFor((m) => m.type === 'scene_set', { timeoutMs: 4000, label: 'scene_set echo' });
  gz2.messages.length = 0;
  gz2.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const afterSet = await gz2.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId, { timeoutMs: 8000, label: 'post-scene_set scene B' });
  check('B11 scene metadata change (loops) invalidates the scene frame',
    (afterSet.scenes.find((s) => s.id === sceneB.sceneId) || {}).loops === 3);

  // Per-frame clear invalidates.
  host.send({ type: 'clear', frameId: sceneB.frameId });
  await sleep(300);
  gz2.messages.length = 0;
  gz2.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const afterClear = await gz2.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId && m.ops.length === 0, { timeoutMs: 8000, label: 'post-clear scene B' });
  check('B12 per-frame clear empties the cached scene frame', afterClear.ops.length === 0);
}

// Superseded scene fetches + ops during a fetch (fresh room, port 19111).
async function partB2(srv) {
  const host = await srv.connect('ZZSUP');
  const [sceneA, sceneB, sceneC] = await setupAnimationRoom(host, 2);
  await sendBurst(host, 300, 'ua', { points: 60, pauseMs: 10, frameId: sceneA.frameId });
  await sendBurst(host, 300, 'ub', { points: 60, pauseMs: 10, frameId: sceneB.frameId });
  await sendBurst(host, 300, 'uc', { points: 60, pauseMs: 10, frameId: sceneC.frameId });
  await sleep(500);

  const member = await srv.connect('ZZSUP', { gz: true });
  await member.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'member join scene' });
  member.messages.length = 0;
  // Hop B then IMMEDIATELY C: the superseded B fetch must never complete late.
  member.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  member.send({ type: 'scene_fetch', sceneId: sceneC.sceneId });
  const cFrame = await member.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'scene C frame' });
  await sleep(700);
  const frames = historyMsgsOf(member);
  check('B13 superseded scene fetch never completes: exactly the LATEST scene arrives',
    frames.length === 1 && cFrame.sceneId === sceneC.sceneId && cFrame.ops.length === 300,
    `${frames.map((f) => f.sceneId)} ops ${frames.map((f) => f.ops.length)}`);
  // ...and the abandoned scene is still fetchable afterwards.
  member.messages.length = 0;
  member.send({ type: 'scene_fetch', sceneId: sceneB.sceneId });
  const bFrame = await member.waitFor((m) => m.type === 'history' && m.sceneId === sceneB.sceneId, { timeoutMs: 10000, label: 'scene B refetch' });
  check('B14 the superseded scene fetches cleanly afterwards', bFrame.ops.length === 300);

  // Ops drawn INTO the fetched scene during its build arrive exactly once,
  // after the frame; ops for OTHER scenes keep flowing (after the frame too).
  const host3 = await srv.connect('ZZGATE');
  const [gA, gB] = await setupAnimationRoom(host3, 1);
  await sendBurst(host3, 200, 'ga', { points: 60, pauseMs: 10, frameId: gA.frameId });
  await sendBurst(host3, 200, 'gb', { points: 60, pauseMs: 10, frameId: gB.frameId });
  await sleep(500);
  const watcher = await srv.connect('ZZGATE', { gz: true });
  await watcher.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'watcher join' });
  watcher.messages.length = 0;
  watcher.send({ type: 'scene_fetch', sceneId: gB.sceneId });
  const gateStop = { stop: false };
  paintUntil(gateStop, host3, 'gate', { everyMs: 4, start: 0, frameId: gB.frameId });
  paintUntil(gateStop, host3, 'other', { everyMs: 7, start: 0, frameId: gA.frameId });
  const gBFrame = await watcher.waitFor((m) => m.type === 'history' && m.sceneId === gB.sceneId, { timeoutMs: 10000, label: 'gated scene frame' });
  await sleep(800);
  gateStop.stop = true;
  await sleep(200);
  const frameIndex = watcher.messages.indexOf(gBFrame);
  const preFrameOps = watcher.messages.slice(0, frameIndex).filter((m) => m.type === 'op');
  check('B15 no canvas op arrives before the gated scene frame', preFrameOps.length === 0, `${preFrameOps.length} early ops`);
  const allOps = reconstructed(watcher, gBFrame);
  assertExactlyOnce('B16 ops during a scene fetch', allOps.filter((o) => String(o.strokeId || '').startsWith('gate-')));
  const otherScene = allOps.filter((o) => String(o.strokeId || '').startsWith('other-'));
  assertExactlyOnce('B17 other-scene ops during a scene fetch', otherScene);
  check('B18 other-scene ops keep flowing to a fetching member', otherScene.length > 0, `${otherScene.length} ops`);
}

// Restart persistence for animation rooms (same server entry, same scratch).
async function partB3(port, scratch) {
  const env = { ...CACHE_ENV };
  let srv = await startServer({ port, env, scratch });
  const host = await srv.connect('ZZRE');
  const [rA, rB] = await setupAnimationRoom(host, 1);
  await sendBurst(host, 120, 'ra', { points: 8, pauseMs: 10, frameId: rA.frameId });
  await sendBurst(host, 120, 'rb', { points: 8, pauseMs: 10, frameId: rB.frameId });
  await sleep(600);
  const before = await srv.connect('ZZRE');
  before.send({ type: 'scene_fetch', sceneId: rB.sceneId });
  const beforeB = await before.waitFor((m) => m.type === 'history' && m.sceneId === rB.sceneId, { timeoutMs: 8000, label: 'pre-restart scene B' });
  await srv.stop();

  srv = await startServer({ port, env, scratch });
  try {
    const rejoined = await srv.connect('ZZRE', { gz: true });
    const joinFrame = await rejoined.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'post-restart join' });
    check('B19 restart: scene A ops intact on rejoin', joinFrame.ops.length === 120 && joinFrame.ops[0].strokeId === 'ra-0',
      `${joinFrame.ops.length} ops`);
    rejoined.send({ type: 'scene_fetch', sceneId: rB.sceneId });
    const afterB = await rejoined.waitFor((m) => m.type === 'history' && m.sceneId === rB.sceneId, { timeoutMs: 8000, label: 'post-restart scene B' });
    assert.deepStrictEqual(afterB.ops, beforeB.ops);
    check('B20 restart: scene B payload identical across restart', true);
  } finally {
    await srv.stop();
  }
}

// ---- Part C: bounded catch-up queue (:19112) --------------------------------
async function partC(scratch) {
  const srv = await startServer({
    port: 19112, scratch,
    env: { ...CACHE_ENV, CATCHUP_QUEUE_MAX_MESSAGES: '4', CATCHUP_QUEUE_MAX_BYTES: '1048576' },
  });
  try {
    const painter = await srv.connect('ZZOVER');
    await sendBurst(painter, 300, 'o', { points: 40, pauseMs: 15 });
    await sleep(400);
    const stopRef = { stop: false };
    const joiner = await srv.connect('ZZOVER', { gz: true });
    paintUntil(stopRef, painter, 'flood', { everyMs: 2, start: 0 });
    await new Promise((resolvePromise) => {
      if (joiner.closed) { resolvePromise(); return; }
      joiner.ws.once('close', resolvePromise);
      setTimeout(resolvePromise, 15000);
    });
    stopRef.stop = true;
    check('C1 catch-up queue overflow disconnects the joiner instead of dropping durable ops',
      joiner.closed && joiner.closeInfo && joiner.closeInfo.code === 1013,
      `closed=${joiner.closed} code=${joiner.closeInfo && joiner.closeInfo.code}`);
    await sleep(400);
    const rejoined = await srv.connect('ZZOVER', { gz: true });
    const h = await rejoined.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'rejoin history' });
    await sleep(400);
    assertExactlyOnce('C2 rejoin after overflow', reconstructed(rejoined, h));
    check('C3 rejoined client receives the complete durable history', h.ops.length >= 300, `${h.ops.length} ops`);
  } finally {
    await srv.stop();
  }
}

// ---- Part D: over-cap film load never front-trims (:19113) -------------------
function seedFilmRoom(scratch) {
  const roomsDir = join(scratch, '.rooms');
  mkdirSync(roomsDir, { recursive: true });
  const layer = { id: 'L0', name: 'Layer 1', visible: true, opacity: 1, locked: false };
  const filmOps = [];
  for (let i = 0; i < 80; i += 1) {
    filmOps.push({
      kind: 'draw', strokeId: `film-${i}`, end: true,
      points: [{ x: 5 + i, y: 5, pressure: 0.5 }],
      settings: { brush: 'marker', size: 6, color: '#222222', opacity: 1 },
      userId: 'u0', opId: i + 1, frameId: i < 40 ? 'f1' : 'f2',
    });
  }
  writeFileSync(join(roomsDir, 'ZWFILM.json'), JSON.stringify({
    audience: 'friends', animation: true,
    scenes: [{ id: 's0', name: 'Scene 1' }],
    frames: [
      { id: 'f1', durationMs: 120, sceneId: 's0', layers: [layer] },
      { id: 'f2', durationMs: 120, sceneId: 's0', layers: [layer] },
    ],
    history: [],
  }));
  writeFileSync(join(roomsDir, 'ZWFILM.history.json'), JSON.stringify({ history: filmOps }));
  const trimOps = filmOps.map((op, i) => ({ ...op, strokeId: `trim-${i}`, frameId: 'f1' }));
  writeFileSync(join(roomsDir, 'ZWTRIM.json'), JSON.stringify({
    audience: 'friends', frames: [{ id: 'f1', durationMs: 120, sceneId: 's0', layers: [layer] }], history: [],
  }));
  writeFileSync(join(roomsDir, 'ZWTRIM.history.json'), JSON.stringify({ history: trimOps }));
}
async function partD(scratch) {
  seedFilmRoom(scratch);
  const env = { ...CACHE_ENV, MAX_ANIM_ROOM_OPS: '50', MAX_HISTORY: '50', MAX_PUBLIC_HISTORY: '50' };
  let srv = await startServer({ port: 19113, env, scratch });
  try {
    const film = await srv.connect('ZWFILM');
    const filmHistory = await film.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'film history' });
    check('D1 over-cap film keeps ALL persisted ops (no front trim)', filmHistory.ops.length === 80, `${filmHistory.ops.length} ops`);
    check('D2 the FIRST frame\'s artwork survives a reduced cap',
      filmHistory.ops[0] && filmHistory.ops[0].opId === 1 && filmHistory.ops[0].frameId === 'f1'
      && filmHistory.ops.filter((o) => o.frameId === 'f1').length === 40);
    check('D3 op order preserved across the reduced-cap load',
      filmHistory.ops.every((op, i) => op.opId === i + 1));
    const trim = await srv.connect('ZWTRIM');
    const trimHistory = await trim.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'trim history' });
    check('D4 single-frame rooms still trim to the rolling cap (guard unchanged)',
      trimHistory.ops.length === 50 && trimHistory.ops[0].opId === 31, `${trimHistory.ops.length} ops from ${trimHistory.ops[0] && trimHistory.ops[0].opId}`);
    // Ingest limits REMAIN: the over-budget film accepts no new ops. (The
    // budget rejection sends frame_full only for non-end batches — end markers
    // relay so peers close their stroke buffers — so probe with an open batch.)
    const extra = drawOp('film-extra', 80, 2); extra.frameId = 'f2'; extra.end = false;
    film.sendOp(extra);
    const full = await film.waitFor((m) => m.type === 'frame_full', { timeoutMs: 4000, label: 'frame_full rejection' });
    check('D5 ingest limits remain: an over-budget film rejects new ops', full.frameId === 'f2');
  } finally {
    await srv.stop();
  }
  srv = await startServer({ port: 19113, env, scratch });
  try {
    const film = await srv.connect('ZWFILM');
    const filmHistory = await film.waitFor((m) => m.type === 'history', { timeoutMs: 10000, label: 'film history after restart' });
    check('D6 over-cap film survives a RESTART whole (80 ops, first frame intact)',
      filmHistory.ops.length === 80 && filmHistory.ops[0].opId === 1 && !filmHistory.ops.some((o) => o.strokeId === 'film-extra'),
      `${filmHistory.ops.length} ops`);
  } finally {
    await srv.stop();
  }
}

// ---- Part E: scene_fetch storm limit + modwatch (:19114) ---------------------
async function partE(scratch) {
  const srv = await startServer({
    port: 19114, scratch,
    env: { ...CACHE_ENV, SCENE_FETCH_MAX: '6', SCENE_FETCH_WINDOW_MS: '10000' },
  });
  try {
    const host = await srv.connect('ZZSTORM');
    const [sA, sB] = await setupAnimationRoom(host, 1);
    await sendBurst(host, 150, 'sa', { points: 30, pauseMs: 10, frameId: sA.frameId });
    await sendBurst(host, 150, 'sb', { points: 30, pauseMs: 10, frameId: sB.frameId });
    await sleep(400);
    const stormy = await srv.connect('ZZSTORM', { gz: true });
    await stormy.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'storm join' });
    stormy.messages.length = 0;
    for (let i = 0; i < 20; i += 1) {
      stormy.send({ type: 'scene_fetch', sceneId: i % 2 ? sA.sceneId : sB.sceneId });
      await sleep(25);
    }
    await sleep(1200);
    const answered = historyMsgsOf(stormy).length;
    check('E1 scene_fetch storms are rate-limited per member', answered >= 2 && answered <= 9, `${answered} answers to 20 fetches`);
    check('E2 a storm-limited member stays connected', !stormy.closed);
    const calm = await srv.connect('ZZSTORM', { gz: true });
    await calm.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'calm join' });
    calm.send({ type: 'scene_fetch', sceneId: sB.sceneId });
    const calmB = await calm.waitFor((m) => m.type === 'history' && m.sceneId === sB.sceneId, { timeoutMs: 8000, label: 'calm fetch' });
    check('E3 other members fetch normally during a storm', calmB.ops.length === 150);

    // Modwatch: gz join gets the shared scene frame; a moderation resync
    // re-delivers the first scene reflecting the hide.
    const mod = new SimClient(`ws://127.0.0.1:19114`, { room: 'ZZSTORM' });
    srv.clients.push(mod);
    const params = new URLSearchParams({ room: 'ZZSTORM', modwatch: '1', gz: '1' });
    mod.ws = new WebSocket(`ws://127.0.0.1:19114/ws?${params}`);
    const modMessages = [];
    mod.ws.on('message', (raw, isBinary) => {
      try {
        modMessages.push(isBinary ? JSON.parse(gunzipSync(raw).toString('utf8')) : JSON.parse(raw.toString()));
      } catch { /* ignore */ }
    });
    mod.binaryFrames = 0;
    mod.ws.on('message', (raw, isBinary) => { if (isBinary) mod.binaryFrames += 1; });
    await new Promise((resolvePromise, reject) => {
      mod.ws.once('open', resolvePromise);
      mod.ws.once('error', reject);
      setTimeout(() => reject(new Error('modwatch open timeout')), 5000);
    });
    mod.ws.send(JSON.stringify({ type: 'mod_auth', key: ADMIN_KEY }));
    for (let attempt = 0; attempt < 100 && !modMessages.some((m) => m.type === 'history'); attempt += 1) await sleep(50);
    const modHistory = modMessages.find((m) => m.type === 'history');
    check('E4 modwatch join receives the scene history', !!modHistory && modHistory.ops.length === 150,
      `${modHistory ? modHistory.ops.length : 'none'} ops`);
    check('E5 modwatch (gz) gets the shared binary scene frame', mod.binaryFrames >= 1, `${mod.binaryFrames} binary frames`);
    const modHiddenId = modHistory.ops[5].opId;
    host.modHide([modHiddenId]);
    for (let attempt = 0; attempt < 100 && modMessages.filter((m) => m.type === 'history').length < 2; attempt += 1) await sleep(50);
    const refreshed = modMessages.filter((m) => m.type === 'history')[1];
    check('E6 modwatch resync re-delivers the scene reflecting the hide',
      !!refreshed && refreshed.ops.length === 149 && !refreshed.ops.some((o) => o.opId === modHiddenId),
      refreshed ? `${refreshed.ops.length} ops` : 'no refresh');
    mod.ws.terminate();
  } finally {
    await srv.stop();
  }
}

const scratchA = mkdtempSync(join(SCRATCH_ROOT, 'main-'));
const scratchC = mkdtempSync(join(SCRATCH_ROOT, 'over-'));
const scratchD = mkdtempSync(join(SCRATCH_ROOT, 'film-'));
const scratchE = mkdtempSync(join(SCRATCH_ROOT, 'storm-'));

const srvMain = await startServer({ port: 19111, env: { ...CACHE_ENV }, scratch: scratchA });
try {
  await part('A atomic join catch-up', () => partA(srvMain));
  await part('B scene cache + invalidation', () => partB(srvMain));
  await part('B2 supersede + gated fetch ordering', () => partB2(srvMain));
} finally {
  await srvMain.stop();
}
await part('B3 restart persistence', () => partB3(19111, scratchA));
await part('C bounded catch-up queue', () => partC(scratchC));
await part('D over-cap film load', () => partD(scratchD));
await part('E storm limit + modwatch', () => partE(scratchE));

for (const dir of [scratchA, scratchC, scratchD, scratchE]) rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\nroom-catchup-phase2-verify: ${assertions} assertions, ${results.length - failed.length}/${results.length} parts passed`);
if (failed.length) {
  console.log(`FAILED PARTS: ${failed.map((f) => `${f.part} (${f.error})`).join('; ')}`);
  process.exit(1);
}
