// Async join-catch-up regression + benchmark (Tier-1 "no event-loop stall"
// acceleration for long-lived rooms — see docs/CATCHUP-IMPLEMENTATION.md).
//
//   Part 0  unit: sliced stringify is BYTE-IDENTICAL to JSON.stringify;
//           frame builder snapshots the ops array (no leak/corruption when
//           ops append or front-trim splices DURING the async build).
//   Part 1  correctness (port 8991): gz frame == legacy text history;
//           frame+tail == full history; concurrent cold joins identical;
//           hide/restore/remove, layer_add and clear invalidate the cache.
//   Part 2  proactive prebuild (ports 8992 on / 8993 off): with prebuild a
//           joiner finds a warm frame (mid-stream lastOpId, small tail); the
//           contrast server proves the lazy path would rebuild at join time.
//   Part 3  stall benchmark (port 8994): 12000 heavy ops (~72MB frame) —
//           event-loop lag (server's own loopLag.maxMs) during a cold gz join.
//
// Baseline comparison: CATCHUP_BENCH_ONLY=1 CATCHUP_BENCH_ROOT=<tree> runs
// only Part 3 against another server tree (e.g. a git worktree of the
// pre-change commit); CATCHUP_BENCH_BASELINE=1 relaxes the lag assertion.
//
// Isolated: scratch DATA_DIR, no auth/billing, no production data. Run with
//   node scripts/history-catchup-async-verify.mjs
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { SimClient } from '../test/harness/client.mjs';
import { stringifyJsonSliced, buildGzippedHistoryFrame } from '../server/historyFrame.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_ROOT = process.env.CATCHUP_BENCH_ROOT ? resolve(process.env.CATCHUP_BENCH_ROOT) : ROOT;
const BENCH_ONLY = !!process.env.CATCHUP_BENCH_ONLY;
const BENCH_BASELINE = !!process.env.CATCHUP_BENCH_BASELINE;
const ADMIN_KEY = 'isolated-history-test';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let assertions = 0;
function check(name, value, detail = '') {
  assert.ok(value, `${name}${detail ? ` — ${detail}` : ''}`);
  assertions += 1;
  console.log(`PASS ${name}`);
}
function drawOp(strokeId, i, points = 1) {
  const pts = [];
  for (let p = 0; p < points; p += 1) pts.push({ x: 10 + i + p * 0.5, y: 20 + p * 0.25, pressure: 0.5 });
  return { kind: 'draw', strokeId, end: true, points: pts, settings: { brush: 'marker', size: 10, color: '#123456', opacity: 1 } };
}

async function withServer({ port, env = {}, serverRoot = ROOT, scratch = null }, run) {
  const own = !scratch;
  scratch = scratch || mkdtempSync(join(tmpdir(), 'drawesome-catchup-'));
  const wrapper = join(scratch, 'fixture.mjs');
  writeFileSync(wrapper, `
    process.on('message', (message) => {
      if (message.type === 'signal') process.emit(message.signal || 'SIGTERM');
    });
    await import(${JSON.stringify(pathToFileURL(join(serverRoot, 'server.js')).href)});
  `);
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = fork(wrapper, [], {
    cwd: serverRoot, silent: true, windowsHide: true,
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
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  const exited = once(child, 'exit');
  const clients = [];
  async function connect(room, opts = {}) {
    const client = new SimClient(`ws://127.0.0.1:${port}`, { room, ...opts });
    clients.push(client);
    await client.connect({ timeoutMs: opts.connectTimeoutMs || 4000 });
    await client.waitFor((m) => m.type === 'history', { timeoutMs: opts.historyTimeoutMs || 15000, label: 'history' });
    return client;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ }
      if (ready) break;
      if (child.exitCode !== null) throw new Error(`Server startup failed: ${logs}`);
      await sleep(40);
    }
    assert.ok(ready, `Isolated server ready on :${port}`);
    await run({ base, scratch, connect, port, logs: () => logs });
  } finally {
    for (const client of clients) client.ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    if (own) rmSync(scratch, { recursive: true, force: true });
  }
}
function opsOf(client) {
  return client.messages.filter((m) => m.type === 'op').map((m) => m.op);
}
function historyOf(client) {
  return client.messages.find((m) => m.type === 'history');
}
async function sendBurst(client, n, prefix, { points = 1, burst = 10, pauseMs = 60, start = 0 } = {}) {
  for (let i = 0; i < n; i += 1) {
    client.sendOp(drawOp(`${prefix}-${start + i}`, start + i, points));
    if (i % burst === burst - 1) await sleep(pauseMs);
  }
}

// ---- Part 0: unit — byte-faithful sliced stringify + snapshot isolation ----
if (!BENCH_ONLY) {
  const pointHeavy = [];
  for (let p = 0; p < 170; p += 1) pointHeavy.push({ x: 1.5 + p * 0.30000000000000004, y: -0, pressure: 1e21 });
  const frames = [{ id: 'f1', name: 'Frame 1', layers: [{ id: 'L1', name: 'Layer 1', visible: true, opacity: 1, locked: false }] }];
  const realistic = {
    type: 'history',
    ops: [
      { kind: 'draw', strokeId: 's-1', end: false, points: pointHeavy, settings: { brush: 'watercolor', size: 12.5, color: '#a1b2c3', opacity: 0.65 }, userId: 'u1', opId: 1 },
      { kind: 'text', text: 'héllo 🎨 "quoted"\nline²', x: 10, y: 20, userId: 'u2', opId: 2, layerId: 'L1' },
      { kind: 'image', asset: 'abc123', w: 100.5, h: null, userId: 'u1', opId: 3 },
      { kind: 'draw', strokeId: 's-2', end: true, points: [], settings: { brush: 'eraser' }, userId: 'u3', opId: 4, extra: undefined },
    ],
    frames,
  };
  const samples = [
    realistic,
    { type: 'history', ops: [], frames },
    { a: Array.from({ length: 300 }, (_, i) => i * 1.5) }, // large nested array → sliced branch
    [Array.from({ length: 300 }, (_, i) => ({ i }))], // root large array
    { nested: { deep: [{ x: [1, [2, [3]]], u: undefined, f: null }] } },
    { s: 'emoji 🖌️ and control\tchars', neg: -0, big: 1e21, small: 4.9e-324 },
    'plain string root', 42, null, true,
  ];
  for (const [idx, sample] of samples.entries()) {
    for (const budgetMs of [1, 8]) {
      const sliced = await stringifyJsonSliced(sample, { budgetMs });
      assert.strictEqual(sliced, JSON.stringify(sample), `sample ${idx} budget ${budgetMs}`);
    }
  }
  check('sliced stringify is byte-identical to JSON.stringify (7 payloads × 2 budgets)', true);

  // Snapshot isolation: mutate the source ops array mid-build — the frame must
  // still contain exactly the 100 ops captured at build start.
  const srcOps = Array.from({ length: 100 }, (_, i) => ({ ...drawOp(`iso-${i}`, i), userId: 'u', opId: i + 1 }));
  const originalJson = JSON.stringify({ type: 'history', ops: srcOps, frames });
  const building = buildGzippedHistoryFrame({ variant: 'full', gen: 1, hiddenGen: 0, framesKey: 'k', msg: { type: 'history', ops: srcOps, frames }, budgetMs: 1 });
  srcOps.push({ kind: 'draw', strokeId: 'late', end: true, points: [], userId: 'u', opId: 101 }); // append DURING build
  srcOps.splice(0, 10); // front-trim splice DURING build
  const entry = await building;
  const frameJson = gunzipSync(entry.gz).toString('utf8');
  check('frame built from a live array is immune to append + splice during the async build', frameJson === originalJson && entry.lastOpId === 100 && entry.opCount === 100, `lastOpId ${entry.lastOpId}, ops ${entry.opCount}`);
}

// ---- Part 1: correctness on :8991 ------------------------------------------
if (!BENCH_ONLY) await withServer({
  port: 8991,
  env: {
    HISTORY_CACHE_MIN_OPS: '100', HISTORY_CACHE_TAIL_MAX: '60', HISTORY_CACHE_PREBUILD_TAIL: '0',
    OP_RATE_PER_SEC: '10000', OP_RATE_BURST: '100000',
  },
}, async ({ connect }) => {
  const painter = await connect('ZZASYNC', { gz: true });
  check('tiny room history is plain text for a gz client', painter.binaryFrames === 0 && historyOf(painter).ops.length === 0);

  await sendBurst(painter, 150, 'a', { pauseMs: 20 });
  await sleep(400);
  const legacy = await connect('ZZASYNC');
  const legacyOps = historyOf(legacy).ops;
  check('legacy (text) joiner gets the full history', legacy.binaryFrames === 0 && legacyOps.length === 150);

  const gz1 = await connect('ZZASYNC', { gz: true });
  const gzOps = historyOf(gz1).ops;
  check('gz joiner gets ONE binary frame with every op', gz1.binaryFrames === 1 && gzOps.length === 150);
  assert.deepStrictEqual(gzOps, legacyOps);
  assert.deepStrictEqual(historyOf(gz1).frames, historyOf(legacy).frames);
  check('gz frame payload is identical to the legacy text history (ops + frames)', true);

  // Tail: ops newer than the cached frame ride as text op messages.
  await sendBurst(painter, 30, 'b', { pauseMs: 20, start: 150 });
  await sleep(300);
  const tailJoiner = await connect('ZZASYNC', { gz: true });
  await sleep(300); // the tail rides as separate frames right after the history frame
  const tailFrame = historyOf(tailJoiner).ops;
  const tailOps = opsOf(tailJoiner);
  check('cache hit: frame holds the first 150 ops', tailJoiner.binaryFrames === 1 && tailFrame.length === 150);
  check('the 30 newer ops arrive as a tail after the frame', tailOps.length === 30 && tailOps[0].opId === 151 && tailOps[29].opId === 180);
  const legacy2 = await connect('ZZASYNC');
  assert.deepStrictEqual([...tailFrame, ...tailOps], historyOf(legacy2).ops);
  check('frame + tail reconstructs the exact full history', true);

  // Concurrent cold joins on a fresh room: one in-flight build, eight joiners,
  // every reconstructed history identical.
  const concPainter = await connect('ZZCONC');
  await sendBurst(concPainter, 300, 'c', { burst: 25, pauseMs: 30 });
  await sleep(600);
  const joiners = await Promise.all(Array.from({ length: 8 }, () => connect('ZZCONC', { gz: true })));
  const first = historyOf(joiners[0]).ops;
  check('every concurrent cold joiner got a complete 300-op history', joiners.every((j) => j.binaryFrames === 1 && historyOf(j).ops.length === 300));
  check('every concurrent cold joiner got an IDENTICAL history', joiners.every((j) => JSON.stringify(historyOf(j).ops) === JSON.stringify(first)));
  check('concurrent join histories cover opIds 1..300 in order', first[0].opId === 1 && first[299].opId === 300);

  // Moderation invalidates the cached frame (painter is host: first member of
  // an ownerless private room).
  painter.modHide([5, 6]);
  await sleep(400);
  const afterHide = await connect('ZZASYNC', { gz: true });
  const hideOps = historyOf(afterHide).ops;
  check('hidden ops drop out of the join frame (hiddenGen invalidation)', hideOps.length === 178 && !hideOps.some((o) => o.opId === 5 || o.opId === 6), `${hideOps.length} ops`);
  painter.modRestore([5, 6]);
  await sleep(400);
  const afterRestore = await connect('ZZASYNC', { gz: true });
  check('restored ops are back in the join frame', historyOf(afterRestore).ops.length === 180);
  painter.modRemove([7]);
  await sleep(400);
  const afterRemove = await connect('ZZASYNC', { gz: true });
  const removeOps = historyOf(afterRemove).ops;
  check('removed ops never come back', removeOps.length === 179 && !removeOps.some((o) => o.opId === 7));
  painter.modRestore([7]);
  await sleep(300);
  const afterBadRestore = await connect('ZZASYNC', { gz: true });
  check('a removed op stays gone even after a restore attempt', historyOf(afterBadRestore).ops.length === 179);

  // Layer structure change → framesKey invalidation → joiner sees new layers.
  painter.send({ type: 'layer_add' });
  await painter.waitFor((m) => m.type === 'layer_add', { timeoutMs: 3000, label: 'layer_add echo' });
  const afterLayer = await connect('ZZASYNC', { gz: true });
  check('join frame after layer_add carries the new layer structure', historyOf(afterLayer).frames[0].layers.length === 2, `${historyOf(afterLayer).frames[0].layers.length} layers`);

  // Clear → no stale frame for the next joiner.
  const clearPainter = await connect('ZZCLEAR');
  await sendBurst(clearPainter, 120, 'w', { pauseMs: 20 });
  await sleep(400);
  const beforeClear = await connect('ZZCLEAR', { gz: true });
  check('pre-clear room serves a gz frame', beforeClear.binaryFrames === 1 && historyOf(beforeClear).ops.length === 120);
  clearPainter.send({ type: 'clear' });
  await sleep(400);
  const afterClear = await connect('ZZCLEAR', { gz: true });
  check('joiner after a clear never sees the stale cached frame', historyOf(afterClear).ops.length === 0 && afterClear.binaryFrames === 0);
});

// ---- Part 2: proactive prebuild on :8992 (on) vs :8993 (off) ----------------
if (!BENCH_ONLY) {
  const prebuildEnv = {
    HISTORY_CACHE_MIN_OPS: '100', HISTORY_CACHE_TAIL_MAX: '60',
    OP_RATE_PER_SEC: '10000', OP_RATE_BURST: '100000',
  };
  const drive = async ({ connect }) => {
    const painter = await connect('ZZPRE', { gz: true });
    await sendBurst(painter, 150, 'p', { pauseMs: 60 });
    await sleep(400);
    const first = await connect('ZZPRE', { gz: true }); // builds the cache (frame=150)
    assert.ok(first.binaryFrames === 1 && historyOf(first).ops.length === 150, 'first gz join builds the cache');
    // 140 more ops, bursts of 10 with pauses so background prebuilds land
    // mid-stream. Triggers at +30/+60/+90/+120 past the frame → last snapshot
    // ≤270, tail at join ∈ [1, 60).
    await sendBurst(painter, 140, 'q', { pauseMs: 80, start: 150 });
    await sleep(500);
    const second = await connect('ZZPRE', { gz: true });
    await sleep(200);
    const frameOps = historyOf(second).ops.length;
    const tailLen = opsOf(second).length;
    const legacy = await connect('ZZPRE');
    assert.deepStrictEqual([...historyOf(second).ops, ...opsOf(second)], historyOf(legacy).ops);
    return { second, frameOps, tailLen };
  };
  await withServer({ port: 8992, env: { ...prebuildEnv, HISTORY_CACHE_PREBUILD_TAIL: '30' } }, async ({ connect }) => {
    const { second, frameOps, tailLen } = await drive({ connect });
    check('prebuild: joiner finds a warm mid-stream frame (no join-time rebuild)', second.binaryFrames === 1 && frameOps >= 180 && frameOps <= 270, `frame ${frameOps} ops`);
    check('prebuild: tail is small but non-zero (frame predates the join)', tailLen >= 1 && tailLen < 60, `tail ${tailLen}`);
    check('prebuild: frame + tail == full 290-op history', frameOps + tailLen === 290, `${frameOps}+${tailLen}`);
  });
  await withServer({ port: 8993, env: { ...prebuildEnv, HISTORY_CACHE_PREBUILD_TAIL: '0' } }, async ({ connect }) => {
    const { second, frameOps, tailLen } = await drive({ connect });
    check('contrast (prebuild off): the same join pays a lazy rebuild — frame covers everything, tail empty', second.binaryFrames === 1 && frameOps === 290 && tailLen === 0, `frame ${frameOps}, tail ${tailLen}`);
  });
}

// ---- Part 3: cold-join event-loop stall benchmark on :8994 ------------------
// 12000 ops × 170 points ≈ 6KB/op (the research fixture shape): ~72MB frame
// JSON. Baseline server: one synchronous stringify on the event loop. Patched:
// sliced async stringify + threadpool gzip.
await withServer({
  port: 8994,
  serverRoot: BENCH_ROOT,
  env: {
    HISTORY_CACHE_MIN_OPS: '200', HISTORY_CACHE_TAIL_MAX: '400', HISTORY_CACHE_PREBUILD_TAIL: '0',
    OP_RATE_PER_SEC: '100000', OP_RATE_BURST: '2000000',
  },
}, async ({ base, connect, scratch }) => {
  const painter = await connect('ZZSTALL');
  const N = 12000;
  for (let i = 0; i < N; i += 1) {
    painter.sendOp(drawOp(`s-${i}`, i, 170));
    if (i % 400 === 399) await sleep(40); // let the socket drain
  }
  // Wait until the server has ingested every op (metrics.strokes is the total
  // op count across rooms) before measuring the join.
  const metrics = async () => (await fetch(`${base}/api/admin/metrics`, { headers: { 'x-admin-key': ADMIN_KEY } })).json();
  let ingested = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    ingested = (await metrics()).strokes;
    if (ingested >= N) break;
    await sleep(200);
  }
  assert.ok(ingested >= N, `server ingested all ${N} ops (saw ${ingested})`);

  const lagSamples = [];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      try { lagSamples.push((await metrics()).loopLag.maxMs); } catch { /* shutting down */ }
      await sleep(40);
    }
  })();
  // External, uncontaminated stall signal: a SEPARATE process hammering
  // /healthz back-to-back and logging RTTs to a file. (An in-process poller
  // is blocked by the test client's own sync 72MB gunzip on frame arrival.)
  const proberCode = `
    const { appendFileSync } = await import('node:fs');
    for (;;) {
      const t = performance.now();
      try {
        await fetch(process.env.RTT_URL);
        appendFileSync(process.env.RTT_OUT, (performance.now() - t).toFixed(1) + '\\n');
      } catch { appendFileSync(process.env.RTT_OUT, 'ERR\\n'); await new Promise((d) => setTimeout(d, 50)); }
    }
  `;
  const startProber = (file) => spawn(process.execPath, ['--input-type=module', '-e', proberCode], {
    env: { ...process.env, RTT_OUT: file, RTT_URL: `${base}/healthz` }, stdio: 'ignore',
  });
  const readSamples = async (prober, file) => {
    prober.kill('SIGKILL');
    await once(prober, 'exit').catch(() => {});
    return readFileSync(file, 'utf8').split('\n').filter((l) => l && l !== 'ERR').map(Number);
  };
  const coldRttFile = join(scratch, 'rtt-cold.log');
  writeFileSync(coldRttFile, '');
  const coldProber = startProber(coldRttFile);
  await sleep(150); // let the prober establish its baseline cadence
  const t0 = Date.now();
  const joiner = await connect('ZZSTALL', { gz: true, connectTimeoutMs: 15000, historyTimeoutMs: 60000 });
  const coldJoinMs = Date.now() - t0;
  const coldRtts = await readSamples(coldProber, coldRttFile);
  const h = historyOf(joiner);
  check('cold gz join delivers all 12000 ops', h.ops.length === N, `${h.ops.length} ops`);
  const coldMaxLag = Math.max(...lagSamples);
  const coldMaxRtt = Math.max(...coldRtts);
  const gzBytes = joiner.binaryBytes;

  lagSamples.length = 0;
  const warmRttFile = join(scratch, 'rtt-warm.log');
  writeFileSync(warmRttFile, '');
  const warmProber = startProber(warmRttFile);
  await sleep(150);
  const t1 = Date.now();
  const warm = await connect('ZZSTALL', { gz: true, connectTimeoutMs: 15000, historyTimeoutMs: 60000 });
  const warmJoinMs = Date.now() - t1;
  polling = false;
  await poller;
  const warmRtts = await readSamples(warmProber, warmRttFile);
  const warmMaxLag = Math.max(...lagSamples);
  const warmMaxRtt = Math.max(...warmRtts);
  check('warm gz join also delivers all 12000 ops', historyOf(warm).ops.length === N);

  const result = {
    mode: BENCH_BASELINE ? 'baseline' : 'patched',
    ops: N,
    gzMB: Math.round((gzBytes / 1048576) * 100) / 100,
    coldJoinMs, coldMaxLagMs: coldMaxLag, coldMaxHealthzRttMs: coldMaxRtt,
    warmJoinMs, warmMaxLagMs: warmMaxLag, warmMaxHealthzRttMs: warmMaxRtt,
  };
  console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
  if (!BENCH_BASELINE) {
    check('event-loop lag during the cold rebuild stays under 100ms', coldMaxLag < 100, `max loopLag ${coldMaxLag}ms`);
    check('/healthz RTT during the cold rebuild stays under 100ms', coldMaxRtt < 100, `max RTT ${coldMaxRtt}ms`);
    check('event-loop lag during the warm join stays under 100ms', warmMaxLag < 100, `max loopLag ${warmMaxLag}ms`);
  }
});

console.log(`\nhistory-catchup-async-verify: ${assertions} assertions passed`);
