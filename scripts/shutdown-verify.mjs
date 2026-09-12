// Isolated shutdown regression: no production data, secrets, or cloud services.
// Windows cannot deliver Unix signals to a Node child, so the fixture dispatches
// SIGTERM/SIGINT through IPC to the same production process signal handlers.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

// Rooms persist as <CODE>.json (meta) + <CODE>.history.json (base) + <CODE>.ops.jsonl
// (appended ops) — read them back the way the server does on boot.
function readRoomHistory(scratch, code) {
  const dir = join(scratch, '.rooms');
  let history = [];
  if (existsSync(join(dir, `${code}.history.json`))) {
    history = JSON.parse(readFileSync(join(dir, `${code}.history.json`), 'utf8')).history;
  } else if (existsSync(join(dir, `${code}.json`))) {
    history = JSON.parse(readFileSync(join(dir, `${code}.json`), 'utf8')).history || [];
  }
  let last = history.length ? history[history.length - 1].opId : 0;
  if (existsSync(join(dir, `${code}.ops.jsonl`))) {
    for (const line of readFileSync(join(dir, `${code}.ops.jsonl`), 'utf8').split('\n').filter(Boolean)) {
      const op = JSON.parse(line);
      if (op.opId > last) { history.push(op); last = op.opId; }
    }
  }
  return history;
}
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SimClient } from '../test/harness/client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
let assertions = 0;
function check(name, value) { assert.ok(value, name); assertions += 1; console.log(`PASS ${name}`); }
async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

async function withServer(options, run) {
  const scratch = mkdtempSync(join(tmpdir(), 'drawesome-shutdown-'));
  const wrapper = join(scratch, 'fixture.mjs');
  writeFileSync(wrapper, `
    import { promises as fs } from 'node:fs';
    let releaseWrite;
    let delayed = false;
    const originalWrite = fs.writeFile.bind(fs);
    fs.writeFile = async (file, ...args) => {
      if (process.env.TEST_DELAY_WRITE === '1' && String(file).endsWith('ZZSTOP.json.tmp') && !delayed) {
        delayed = true;
        await new Promise((resolve) => { releaseWrite = resolve; process.send({ type: 'write-started' }); });
      }
      return originalWrite(file, ...args);
    };
    process.on('message', (message) => {
      if (message.type === 'signal') process.emit(message.signal || 'SIGTERM');
      if (message.type === 'release-write') releaseWrite?.();
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
      CHAT_LOG_DIR: join(scratch, '.chatlog'), PB_URL: options.authUrl || '',
      POCKETBASE_URL: '', ADMIN_KEY: 'isolated-shutdown-test', AUTO_CLOSE: 'off',
      STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_CHECKOUT_ENABLED: 'false',
      ENABLE_CLIENT_SNAPSHOTS: '', TEST_DELAY_WRITE: options.delayWrite ? '1' : '',
    },
  });
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  const exited = once(child, 'exit');
  const clients = [];
  async function connect() {
    const client = new SimClient(`ws://127.0.0.1:${port}`, { room: 'ZZSTOP' });
    clients.push(client);
    await client.connect();
    await client.waitFor((message) => message.type === 'history');
    return client;
  }
  async function stroke(sender, observer, strokeId) {
    sender.sendOp({ kind: 'draw', strokeId, end: true,
      points: [{ x: 10, y: 20, pressure: 0.5 }],
      settings: { brush: 'round', size: 10, color: '#123456', opacity: 1 } });
    await observer.waitFor((message) => message.type === 'op' && message.op.strokeId === strokeId);
  }
  async function stop(signal = 'SIGTERM') {
    const started = Date.now();
    child.send({ type: 'signal', signal });
    const [code, exitSignal] = await within(exited, 11000, 'Shutdown exceeded its bound');
    return { code, exitSignal, elapsed: Date.now() - started };
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ }
      if (ready) break;
      if (child.exitCode !== null) throw new Error(`Server startup failed: ${logs}`);
      await sleep(40);
    }
    assert.ok(ready, 'Isolated server ready');
    await run({ child, base, scratch, connect, stroke, stop, logs: () => logs });
  } finally {
    for (const client of clients) client.ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    // This directory is generated by mkdtemp for this test only.
    if (resolve(scratch).startsWith(resolve(tmpdir()) + '\\') || resolve(scratch).startsWith(resolve(tmpdir()) + '/')) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

await withServer({}, async ({ connect, stroke, stop, scratch, base }) => {
  const painter = await connect();
  const observer = await connect();
  const save = await fetch(`${base}/api/artworks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userKey: 'shutdown-device', name: 'Before restart', image: PNG }) });
  check('anonymous gallery save is accepted', save.ok);
  await stroke(painter, observer, 'latest-before-debounce');
  const result = await stop('SIGINT');
  check('SIGINT exits successfully within the deployment grace', result.code === 0 && result.elapsed < 8000);
  check('both active drawing clients close cleanly for restart', [painter, observer].every((client) => client.closeInfo?.code === 1012));
  check('latest acknowledged stroke survives immediate shutdown', readRoomHistory(scratch, 'ZZSTOP').some((op) => op.strokeId === 'latest-before-debounce'));
  check('acknowledged anonymous artwork remains saved', JSON.parse(readFileSync(join(scratch, '.artworks/shutdown-device.json'), 'utf8')).length === 1);
  const analytics = JSON.parse(readFileSync(join(scratch, '.analytics.json'), 'utf8'));
  check('disconnect analytics are flushed after clients close', analytics.sessions.length === 2 && analytics.sessions.every((session) => !session.active && session.leftAt));
});

await withServer({ delayWrite: true }, async ({ child, connect, stroke, stop, scratch }) => {
  const painter = await connect();
  const observer = await connect();
  const started = new Promise((done) => child.on('message', (message) => { if (message.type === 'write-started') done(); }));
  await stroke(painter, observer, 'already-writing');
  await within(started, 5000, 'Room write did not start');
  await stroke(painter, observer, 'newer-than-write');
  const stopped = stop();
  await sleep(150);
  check('shutdown waits for an already running asynchronous room write', child.exitCode === null);
  child.send({ type: 'release-write' });
  const result = await stopped;
  check('SIGTERM exits successfully after the pending write completes', result.code === 0);
  const history = readRoomHistory(scratch, 'ZZSTOP');
  check('queued newer room state follows the older in-flight write', ['already-writing', 'newer-than-write'].every((id) => history.some((op) => op.strokeId === id)));
});

await withServer({}, async ({ connect, stroke, stop, scratch }) => {
  const painter = await connect();
  const observer = await connect();
  await stroke(painter, observer, 'unresponsive-client');
  painter.ws.pause();
  const result = await stop();
  check('unresponsive WebSocket clients cannot block a graceful restart', result.code === 0 && result.elapsed >= 1800 && result.elapsed < 8000);
  check('forced socket cleanup still flushes the final mural', readRoomHistory(scratch, 'ZZSTOP').some((op) => op.strokeId === 'unresponsive-client'));
});

let authSeen;
let releaseAuth;
const requested = new Promise((done) => { authSeen = done; });
const auth = createServer(async (_req, res) => {
  authSeen();
  await new Promise((done) => { releaseAuth = done; });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ record: { id: 'shutdown_mock_owner' } }));
}).listen(0, '127.0.0.1');
await once(auth, 'listening');
try {
  await withServer({ authUrl: `http://127.0.0.1:${auth.address().port}` }, async ({ child, base, stop, scratch }) => {
    const save = fetch(`${base}/api/artworks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer shutdown-mock-token' },
      body: JSON.stringify({ name: 'In-flight save', image: PNG }) });
    await requested;
    const stopped = stop();
    await sleep(150);
    check('shutdown allows an accepted HTTP save to finish', child.exitCode === null);
    releaseAuth();
    check('in-flight save receives its normal success response', (await save).ok);
    check('shutdown exits after HTTP completion', (await stopped).code === 0);
    check('in-flight account save is durable before exit', JSON.parse(readFileSync(join(scratch, '.artworks/pb_shutdown_mock_owner.json'), 'utf8')).length === 1);
  });
} finally {
  releaseAuth?.();
  await new Promise((done) => auth.close(done));
}

await withServer({}, async ({ base, stop, logs }) => {
  // A request that never supplies its promised JSON body holds HTTP open.
  const stalled = request(`${base}/api/artworks`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '999' } });
  stalled.on('error', () => {});
  stalled.write('{');
  await sleep(100);
  const result = await stop();
  stalled.destroy();
  check('stalled requests enforce a bounded non-successful shutdown', result.code === 1 && result.elapsed >= 7500 && result.elapsed < 10000);
  check('shutdown timeout is reported without room data or secrets', logs().includes('Shutdown timed out before all requests and room saves completed.'));
});

console.log(`Shutdown regression: ${assertions} checks passed.`);
