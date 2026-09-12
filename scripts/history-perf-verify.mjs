// History-path regression: the four O(history) fixes from the tracking audit.
//   1. per-socket op rate limit (token bucket)
//   2. shared gzipped join frame + per-join tail (members AND spectators)
//   3. append-only op log with compaction + restart merge
//   4. public-room history cap (MAX_PUBLIC_HISTORY)
// Isolated: temp DATA_DIR, no auth/billing, no production data. Run with
//   node scripts/history-perf-verify.mjs
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SimClient } from '../test/harness/client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let assertions = 0;
function check(name, value, detail = '') {
  assert.ok(value, `${name}${detail ? ` — ${detail}` : ''}`);
  assertions += 1;
  console.log(`PASS ${name}`);
}
async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}
function drawOp(strokeId, i) {
  return { kind: 'draw', strokeId, end: true, points: [{ x: 10 + i, y: 20, pressure: 0.5 }], settings: { brush: 'marker', size: 10, color: '#123456', opacity: 1 } };
}

async function withServer({ env = {}, scratch = null }, run) {
  const own = !scratch;
  scratch = scratch || mkdtempSync(join(tmpdir(), 'drawesome-history-'));
  const wrapper = join(scratch, 'fixture.mjs');
  writeFileSync(wrapper, `
    process.on('message', (message) => {
      if (message.type === 'signal') process.emit(message.signal || 'SIGTERM');
    });
    await import(${JSON.stringify(pathToFileURL(join(ROOT, 'server.js')).href)});
  `);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const child = fork(wrapper, [], {
    cwd: ROOT, silent: true, windowsHide: true,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: scratch,
      ROOM_DIR: join(scratch, '.rooms'), ARTWORK_DIR: join(scratch, '.artworks'),
      CHAT_LOG_DIR: join(scratch, '.chatlog'), PB_URL: '', POCKETBASE_URL: '',
      ADMIN_KEY: 'isolated-history-test', AUTO_CLOSE: 'off',
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
    await client.connect();
    await client.waitFor((m) => m.type === 'history', { timeoutMs: 8000, label: 'history' });
    return client;
  }
  async function stop() {
    child.send({ type: 'signal', signal: 'SIGTERM' });
    const [code] = await exited;
    return code;
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ }
      if (ready) break;
      if (child.exitCode !== null) throw new Error(`Server startup failed: ${logs}`);
      await sleep(40);
    }
    assert.ok(ready, 'Isolated server ready');
    await run({ base, scratch, connect, stop, port, logs: () => logs });
  } finally {
    for (const client of clients) client.ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    if (own && (resolve(scratch).startsWith(resolve(tmpdir()) + '\\') || resolve(scratch).startsWith(resolve(tmpdir()) + '/'))) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

// Pace sends under the bucket (burst 120 / 30 per second by default) so a
// legitimate stream of N ops is never dropped — mirrors a real client's cadence.
async function sendPaced(client, n, prefix) {
  for (let i = 0; i < n; i += 1) {
    client.sendOp(drawOp(`${prefix}-${i}`, i));
    if (i % 20 === 19) await sleep(700);
  }
}
function opsOf(client) {
  return client.messages.filter((m) => m.type === 'op').map((m) => m.op);
}
function historyOf(client) {
  return client.messages.find((m) => m.type === 'history');
}
// What the server reconstructs on boot: .history.json base (or legacy inline
// history in the meta file) + the newer ops appended to .ops.jsonl.
function readRoomHistory(dir, code) {
  const roomsDir = join(dir, '.rooms');
  let history = [];
  if (existsSync(join(roomsDir, `${code}.history.json`))) {
    history = JSON.parse(readFileSync(join(roomsDir, `${code}.history.json`), 'utf8')).history;
  } else if (existsSync(join(roomsDir, `${code}.json`))) {
    history = JSON.parse(readFileSync(join(roomsDir, `${code}.json`), 'utf8')).history || [];
  }
  let last = history.length ? history[history.length - 1].opId : 0;
  if (existsSync(join(roomsDir, `${code}.ops.jsonl`))) {
    for (const line of readFileSync(join(roomsDir, `${code}.ops.jsonl`), 'utf8').split('\n').filter(Boolean)) {
      const op = JSON.parse(line);
      if (op.opId > last) { history.push(op); last = op.opId; }
    }
  }
  return history;
}

// ---- 1. rate limit -----------------------------------------------------------
await withServer({ env: { OP_RATE_PER_SEC: '10', OP_RATE_BURST: '40' } }, async ({ connect }) => {
  const painter = await connect('ZZRATE');
  const observer = await connect('ZZRATE');
  for (let i = 0; i < 300; i += 1) painter.sendOp(drawOp(`blast-${i}`, i));
  await sleep(1200);
  const seen = opsOf(observer).length;
  check('op flood is capped at the bucket (burst + ~1s refill)', seen >= 40 && seen <= 40 + 15, `observer saw ${seen} of 300`);
  await sleep(2500);
  painter.sendOp(drawOp('after-refill', 0));
  await observer.waitFor((m) => m.type === 'op' && m.op.strokeId === 'after-refill', { timeoutMs: 3000, label: 'op after refill' });
  check('bucket refills — a normal op goes through again', true);
});

// ---- 2 + 3 + 4. join cache, persistence, restart merge, public cap ----------
const scratch = mkdtempSync(join(tmpdir(), 'drawesome-history-'));
mkdirSync(join(scratch, '.rooms'), { recursive: true });
// A public room file over the public cap: it must reload trimmed to the cap.
const bigPublic = [];
for (let i = 1; i <= 260; i += 1) bigPublic.push({ ...drawOp(`old-${i}`, i), userId: 'u1', opId: i });
writeFileSync(join(scratch, '.rooms', 'MAIN.json'), JSON.stringify({ history: bigPublic, savedAt: Date.now(), audience: 'kid_safe', listed: true }));

await withServer({ scratch, env: { HISTORY_CACHE_MIN_OPS: '200', HISTORY_CACHE_TAIL_MAX: '50', MAX_PUBLIC_HISTORY: '250', OPLOG_COMPACT_OPS: '400' } }, async ({ connect, scratch: dir, stop }) => {
  const roomBase = join(dir, '.rooms', 'ZZCACHE.json');
  const roomLog = join(dir, '.rooms', 'ZZCACHE.ops.jsonl');

  // Public cap on load.
  const mainViewer = await connect('MAIN', { gz: true });
  const mainHistory = historyOf(mainViewer);
  check('public room reloads trimmed to MAX_PUBLIC_HISTORY', mainHistory.ops.length === 250 && mainHistory.ops[0].opId === 11, `${mainHistory.ops.length} ops, first opId ${mainHistory.ops[0]?.opId}`);
  check('over-threshold public history arrives as ONE gzip frame', mainViewer.binaryFrames === 1);

  // Small room → plain text even for a gz client.
  const painter = await connect('ZZCACHE', { gz: true });
  check('tiny room history is plain text for a gz client', painter.binaryFrames === 0 && historyOf(painter).ops.length === 0);

  await sendPaced(painter, 300, 'a');
  const legacy = await connect('ZZCACHE');
  const legacyHistory = historyOf(legacy);
  check('legacy (text) joiner still gets the full history', legacy.binaryFrames === 0 && legacyHistory.ops.length === 300, `${legacyHistory.ops.length}`);

  const gzJoiner = await connect('ZZCACHE', { gz: true });
  const gzHistory = historyOf(gzJoiner);
  check('gz joiner gets the cached gzip frame with every op', gzJoiner.binaryFrames === 1 && gzHistory.ops.length === 300 && Array.isArray(gzHistory.frames), `${gzHistory.ops.length}`);

  // Tail: ops newer than the cached frame ride as text op messages, in order.
  await sendPaced(painter, 30, 'b');
  const tailJoiner = await connect('ZZCACHE', { gz: true });
  await sleep(300);
  const tailHistory = historyOf(tailJoiner);
  const tailOps = opsOf(tailJoiner);
  check('cache hit: frame still holds the first 300 ops', tailJoiner.binaryFrames === 1 && tailHistory.ops.length === 300);
  check('the 30 newer ops arrive as a tail after the frame', tailOps.length === 30 && tailOps[0].opId === 301 && tailOps[29].opId === 330, `${tailOps.length} tail ops, ids ${tailOps[0]?.opId}..${tailOps[tailOps.length - 1]?.opId}`);
  const histIdx = tailJoiner.messages.findIndex((m) => m.type === 'history');
  const firstOpIdx = tailJoiner.messages.findIndex((m) => m.type === 'op');
  check('tail ops are delivered AFTER the history frame', histIdx >= 0 && firstOpIdx > histIdx);

  // Past the tail cap the frame is rebuilt — every op in one frame again.
  await sendPaced(painter, 40, 'c');
  const rebuiltJoiner = await connect('ZZCACHE', { gz: true });
  await sleep(300);
  check('tail past HISTORY_CACHE_TAIL_MAX rebuilds the frame', rebuiltJoiner.binaryFrames === 1 && historyOf(rebuiltJoiner).ops.length === 370 && opsOf(rebuiltJoiner).length === 0, `${historyOf(rebuiltJoiner).ops.length} in frame, ${opsOf(rebuiltJoiner).length} tail`);

  // Spectators share the mechanism.
  // (Private rooms refuse spectators by design — watch the public MAIN room.)
  const spectator = await connect('MAIN', { gz: true, spectate: true });
  check('homepage spectator gets the gzip frame too', spectator.binaryFrames === 1 && historyOf(spectator).ops.length === 250, `${spectator.binaryFrames} frames, ${historyOf(spectator)?.ops?.length} ops`);
  spectator.ws.terminate();

  // Persistence: history base + small meta file + append-only op log.
  const roomHist = join(dir, '.rooms', 'ZZCACHE.history.json');
  await sleep(3000);
  // The first flush wrote the base; every flush since appended → base + log = 370.
  check('history base (.history.json) + op log reconstruct every op', existsSync(roomHist) && readRoomHistory(dir, 'ZZCACHE').length === 370, `${readRoomHistory(dir, 'ZZCACHE').length}`);
  const metaFile = JSON.parse(readFileSync(roomBase, 'utf8'));
  check('meta file is small: no inline history, carries opCount for the idle sweep', !('history' in metaFile) && metaFile.opCount >= 300 && metaFile.savedAt > 0);
  const histBefore = statSync(roomHist).mtimeMs;
  const histSize = statSync(roomHist).size;
  const logBefore = existsSync(roomLog) ? readFileSync(roomLog, 'utf8').split('\n').filter(Boolean).length : 0;
  await sendPaced(painter, 20, 'd');
  await sleep(3000);
  const logLines = existsSync(roomLog) ? readFileSync(roomLog, 'utf8').split('\n').filter(Boolean) : [];
  check('later ops append to the op log instead of rewriting the history base', logLines.length === logBefore + 20 && statSync(roomHist).size === histSize && statSync(roomHist).mtimeMs === histBefore, `${logBefore} → ${logLines.length} log lines`);
  // A chat line / join / leave only touches the small meta file now.
  painter.sendChat('hello wall');
  const chatter = await connect('ZZCACHE');
  chatter.ws.close();
  await sleep(3200);
  check('chat + join/leave rewrite only the meta file, never the history base', statSync(roomHist).mtimeMs === histBefore && JSON.parse(readFileSync(roomBase, 'utf8')).chat.some((m) => m.message === 'hello wall'));

  // A clear reassigns history → the next save rewrites the base + empties the log.
  painter.send({ type: 'clear' });
  await sleep(3200);
  check('history reassignment (clear) rewrites the base and truncates the log', JSON.parse(readFileSync(roomHist, 'utf8')).history.length === 0 && statSync(roomLog).size === 0);
  const afterClear = await connect('ZZCACHE', { gz: true });
  check('joiner after a clear never sees the stale cached frame', historyOf(afterClear).ops.length === 0 && afterClear.binaryFrames === 0);

  // Ops after the clear: empty base + log carry them across a restart.
  await sendPaced(painter, 25, 'e');
  await sleep(3200);
  const postClearLog = readFileSync(roomLog, 'utf8').split('\n').filter(Boolean);
  check('post-clear ops land in the log', postClearLog.length === 25, `${postClearLog.length} log lines, base has ${JSON.parse(readFileSync(roomHist, 'utf8')).history.length} ops`);
  const code = await stop();
  check('server shuts down cleanly with logged ops', code === 0);
});

// Restart on the same data dir: base + log merge back into one history.
await withServer({ scratch, env: {} }, async ({ connect, scratch: dir }) => {
  const joiner = await connect('ZZCACHE', { gz: true });
  const h = historyOf(joiner);
  check('after restart the room history = base + appended log', h.ops.length === 25 && h.ops[0].strokeId === 'e-0' && h.ops[24].strokeId === 'e-24', `${h.ops.length} ops`);
  const painter = joiner;
  painter.sendOp(drawOp('post-restart', 1));
  await sleep(3000);
  // The base (empty since the clear) is reused as-is; the new op appends to the
  // log behind the 25 that were already there — no compaction, no rewrite.
  const base = JSON.parse(readFileSync(join(dir, '.rooms', 'ZZCACHE.history.json'), 'utf8'));
  const merged = readRoomHistory(dir, 'ZZCACHE');
  check('a restart keeps appending to the same base (no compaction needed)', base.history.length === 0 && merged.length === 26 && merged[25].strokeId === 'post-restart', `base ${base.history.length}, merged ${merged.length}`);
  check('opIds stay monotonic across the restart', merged[25].opId > merged[24].opId);
});
rmSync(scratch, { recursive: true, force: true });

console.log(`\nhistory-perf-verify: ${assertions} assertions passed`);

