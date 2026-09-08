// Isolated regression checks for batching and bounded room history.
// Snapshot transport/default-off checks live in launch-reliability-verify.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SimClient } from '../test/harness/client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'happypaint-perf-'));
const clients = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const settings = (color = '#123456') => ({ brush: 'marker', color, size: 24, opacity: 1, seed: 1, v: 3 });
const draw = (strokeId, extra = {}) => ({ kind: 'draw', strokeId, points: [{ x: 10, y: 20, pressure: 0.5 }], settings: settings(), ...extra });
let assertions = 0;
let server;
let serverExited;
let logs = '';
function check(name, condition) {
  assert.ok(condition, name);
  assertions += 1;
  console.log('PASS ' + name);
}
const mockAuth = createServer((req, res) => {
  const valid = req.method === 'POST' && req.url === '/api/collections/users/auth-refresh' && req.headers.authorization === 'perf-host';
  res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(valid ? { record: { id: 'perf-test-host', name: 'Host' } } : {}));
});

try {
  mkdirSync(join(scratch, '.rooms'));
  writeFileSync(join(scratch, '.rooms/RECOVER.json'), JSON.stringify({
    audience: 'friends', savedAt: Date.now(),
    frames: [{ id: 'f1', sceneId: 's1' }, { id: 'f2', sceneId: 's1' }],
    history: [
      draw('shared', { userId: 'one', frameId: 'f1', opId: 1, settings: settings('#ff0000') }),
      draw('shared', { userId: 'two', frameId: 'f1', opId: 2, settings: settings('#0000ff') }),
      draw('shared', { userId: 'one', frameId: 'f2', opId: 3, settings: settings('#00ff00') }),
      draw('shared', { userId: 'one', frameId: 'f1', opId: 4, settings: undefined, end: true }),
      draw('shared', { userId: 'two', frameId: 'f1', opId: 5, settings: undefined, end: true }),
      draw('shared', { userId: 'one', frameId: 'f2', opId: 6, settings: undefined, end: true }),
    ],
  }));

  mockAuth.listen(0, '127.0.0.1');
  await once(mockAuth, 'listening');
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), DATA_DIR: scratch,
      ROOM_DIR: join(scratch, '.rooms'), ARTWORK_DIR: join(scratch, '.artworks'),
      CHAT_LOG_DIR: join(scratch, '.chatlog'), ADMIN_KEY: 'isolated-perf-test',
      PB_URL: 'http://127.0.0.1:' + mockAuth.address().port, POCKETBASE_URL: '',
      STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', ENABLE_CLIENT_SNAPSHOTS: '',
      MAX_HISTORY: '5', FRAME_OP_CAP: '8', AUTO_CLOSE: 'off',
    },
  });
  server.stdout.on('data', (data) => { logs += data; });
  server.stderr.on('data', (data) => { logs += data; });
  serverExited = once(server, 'exit');
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (server.exitCode !== null) throw new Error('Server exited: ' + logs);
    try { ready = (await fetch('http://127.0.0.1:' + port + '/healthz')).ok; } catch { /* starting */ }
    if (ready) break;
    await sleep(50);
  }
  assert.ok(ready, 'Server startup timed out: ' + logs);
  async function connect(room, token = null) {
    const client = new SimClient('ws://127.0.0.1:' + port, { room, token, name: room + '-' + clients.length });
    clients.push(client);
    await client.connect();
    await client.waitFor((msg) => msg.type === 'history');
    return client;
  }
  async function flush(client) {
    const previous = client.all('pong').length;
    client.send({ type: 'ping' });
    await client.waitFor((msg) => msg.type === 'pong' && client.all('pong').length > previous);
  }

  const recovered = await connect('RECOVER');
  const recoveredTail = recovered.last('history').ops.slice(-3);
  check('stored settings-once strokes recover without crossing authors or frames', recoveredTail.map((op) => op.settings.color).join(',') === '#ff0000,#0000ff,#00ff00');
  const host = await connect('BATCH', 'perf-host');
  const guest = await connect('BATCH');
  check('mock-auth host shares the room with an anonymous painter', host.connected.isOwner && !guest.connected.profileId);
  const invalidOps = [
    null, [], 'bad',
    draw('invalid-null', { points: [null] }),
    draw('invalid-coords', { points: [{ x: '10', y: 20 }] }),
    draw('invalid-id', { strokeId: { toString: 'bad' } }),
    draw('invalid-settings', { settings: [] }),
    draw('invalid-many', { points: Array.from({ length: 2049 }, () => ({ x: 1, y: 1 })) }),
    draw('invalid-large', { settings: { text: 'x'.repeat(128_000) } }),
  ];
  for (const op of invalidOps) guest.sendOp(op);
  await flush(guest);
  const invalidJoiner = await connect('BATCH');
  check('malformed draw batches are neither relayed nor persisted', invalidJoiner.last('history').ops.length === 0 && host.all('op').length === 0);

  guest.sendOp(draw('live', { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }));
  guest.sendOp(draw('live', { points: [{ x: 5, y: 6 }], end: true }));
  await host.waitFor((msg) => msg.type === 'op' && msg.op.strokeId === 'live' && msg.op.end);
  check('batched drawing and end markers relay with standalone settings', host.all('op').filter((msg) => msg.op.strokeId === 'live').every((msg) => msg.op.settings.brush === 'marker'));
  for (let i = 0; i < 12; i += 1) guest.sendOp(draw('fill-' + i, { end: true }));
  await flush(guest);
  const late = await connect('BATCH');
  check('FIFO history stays within the configured bound', late.last('history').ops.length === 5);
  host.send({ type: 'set_animation', enabled: true });
  await host.waitFor((msg) => msg.type === 'room_animation' && msg.enabled);
  guest.sendOp(draw('after-toggle'));
  await host.waitFor((msg) => msg.type === 'op' && msg.op.strokeId === 'after-toggle');
  check('enabling animation uses retained op counts rather than total lifetime draws', guest.all('frame_full').length === 0);

  // Old settings-once clients can remain connected during a rolling update.
  const one = await connect('TRIM');
  const two = await connect('TRIM');
  one.sendOp(draw('same-id', { settings: settings('#ff0000') }));
  await flush(one);
  two.sendOp(draw('same-id', { settings: settings('#0000ff') }));
  await flush(two);
  one.sendOp(draw('same-id', { settings: undefined }));
  two.sendOp(draw('same-id', { settings: undefined }));
  await Promise.all([flush(one), flush(two)]);
  one.sendOp(draw('filler1', { end: true }));
  one.sendOp(draw('filler2', { end: true }));
  one.sendOp(draw('filler3', { end: true }));
  await flush(one);
  const trimmed = await connect('TRIM');
  const survivorByUser = new Map(trimmed.last('history').ops.filter((op) => op.strokeId === 'same-id').map((op) => [op.userId, op]));
  check("trimming preserves each author's own stroke settings", survivorByUser.get(one.connected.userId)?.settings.color === '#ff0000' && survivorByUser.get(two.connected.userId)?.settings.color === '#0000ff');
  check('normal joins never request client-rendered snapshots', clients.every((client) => client.all('snapshot_request').length === 0 && client.all('snapshot').length === 0));
  console.log('Performance server checks passed (' + assertions + ' assertions).');
} catch (error) {
  error.message += '\nServer output:\n' + logs;
  throw error;
} finally {
  await Promise.all(clients.map((client) => client.close()));
  if (server && server.exitCode === null) server.kill();
  if (serverExited) await serverExited;
  if (mockAuth.listening) await new Promise((done) => mockAuth.close(done));
  const target = resolve(scratch).replace(/\\/g, '/');
  const allowedPrefix = resolve(tmpdir()).replace(/\\/g, '/') + '/happypaint-perf-';
  assert.ok(target.startsWith(allowedPrefix), 'Cleanup is confined to the generated temporary directory');
  rmSync(scratch, { recursive: true, force: true });
}
