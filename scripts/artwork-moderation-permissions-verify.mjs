// Real-server regression: reports/forged classifier flags are not edit grants.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'artwork-moderation-permissions-'));
const clock = join(scratch, 'clock.txt');
await writeFile(clock, '2026-10-05T12:00:00.000Z');
const origin = 'http://127.0.0.1:9245';
const sockets = [], cases = [], checks = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let child, log = '';
const mock = http.createServer((req, res) => {
  const id = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.method === 'POST' && req.url === '/api/collections/users/auth-refresh' && ['owner', 'viewer', 'secondViewer'].includes(id)) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ record: { id, verified: true } }));
  } else res.writeHead(401).end('{}');
});
async function api(path, token, body) {
  const res = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: await res.json() };
}
async function boot() {
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '9245', DATA_DIR: join(scratch, 'data'), PB_URL: 'http://127.0.0.1:9246', INKTOBER_CLOCK_FILE: clock }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (data) => { log += data; }); child.stderr.on('data', (data) => { log += data; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Server exited during startup');
    try { if ((await fetch(origin + '/healthz')).ok) return; } catch { /* startup */ }
    await sleep(100);
  }
  throw new Error('Server startup timed out');
}
async function stop() { if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } }
async function connect(code, token = null, device = 'u_attackDevice') {
  const ws = new WebSocket(`ws://127.0.0.1:9245/ws?room=${code}`), client = { ws, messages: [] };
  sockets.push(ws); ws.on('message', (data) => { try { client.messages.push(JSON.parse(data)); } catch { /* binary not requested */ } });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', token, userKey: device }));
  for (let i = 0; i < 60; i++) { if (client.messages.some((m) => m.type === 'history') || ws.readyState === WebSocket.CLOSED) return client; await sleep(30); }
  throw new Error('Room handshake timed out');
}
const send = (client, message) => client.ws.send(JSON.stringify(message));
const last = (client, type) => client.messages.filter((m) => m.type === type).at(-1);
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function attackFixture(name, code, ownerToken = 'owner', ownerDevice = 'u_ownerDevice', attackerToken = null) {
  const owner = await connect(code, ownerToken, ownerDevice);
  assert.equal(last(owner, 'connected')?.canPaint, true, `${name}: owner can paint`);
  const observer = await connect(code, attackerToken);
  const strokeId = `original-${name}`;
  send(owner, { type: 'op', op: { kind: 'draw', strokeId, settings: { brush: 'ink', size: 4, color: '#11212b' }, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] } });
  await sleep(120);
  const opId = observer.messages.find((m) => m.type === 'op' && m.op.strokeId === strokeId)?.op.opId;
  assert(opId, `${name}: owner stroke must reach authorized observer`);
  const report = await api('/api/report', null, { room: code, reason: 'Synthetic moderation authorization check' });
  assert.equal(report.status, 200);
  send(observer, { type: 'flag', kind: 'image', score: 0, sinceOpId: 0, toOpId: opId });
  const second = await connect(code, attackerToken || 'secondViewer');
  send(second, { type: 'flag', kind: 'image', score: 1, sinceOpId: 0, toOpId: opId });
  await sleep(120);
  await check(`${name}: self-report and fabricated multi-account flags cannot hide owner strokes`, async () => {
    const fresh = await connect(code, ownerToken, ownerDevice);
    assert(last(fresh, 'history')?.ops?.some((op) => op.strokeId === strokeId), 'Original stroke was suppressed');
  });
  await check(`${name}: reports do not prevent subsequent painting`, async () => {
    const next = `after-report-${name}`;
    send(owner, { type: 'op', op: { kind: 'draw', strokeId: next, settings: { brush: 'ink', size: 4 }, points: [{ x: 30, y: 30 }] } });
    await sleep(120);
    assert(observer.messages.some((m) => m.type === 'op' && m.op.strokeId === next), 'Artist was muted');
  });
  cases.push({ name, code, ownerToken, ownerDevice, strokeId });
}
try {
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(9246, '127.0.0.1', resolve); });
  await boot();
  const studio = await api('/api/rooms', 'owner', { audience: 'artist_public', title: 'Permission fixture' }); assert.equal(studio.status, 200);
  await attackFixture('studio', studio.json.code);
  const made = await api('/api/sketchbooks', 'owner', { public: false }); assert.equal(made.status, 200);
  const bookId = made.json.book.id;
  const page = await api(`/api/sketchbooks/${bookId}/pages`, 'owner', { day: 1 }); assert.equal(page.status, 200);
  const invitation = await api(`/api/sketchbooks/${bookId}/invites`, 'owner', {});
  assert.equal((await api('/api/sketchbooks/accept', 'viewer', { token: invitation.json.token })).status, 200);
  await attackFixture('private-book', page.json.page.room, 'owner', 'u_ownerDevice', 'viewer');
  assert.equal((await api(`/api/sketchbooks/${bookId}/visibility`, 'owner', { public: true })).status, 200);
  const publicPage = await api(`/api/sketchbooks/${bookId}/pages`, 'owner', { day: 2 });
  await attackFixture('public-book', publicPage.json.page.room);
  const guest = await api('/api/sketchbooks/guest', null, { device: 'u_guestOwnerDevice', day: 1 }); assert.equal(guest.status, 200);
  await attackFixture('guest-book', guest.json.room, null, 'u_guestOwnerDevice');
  for (const ws of sockets) ws.close();
  await sleep(100); await stop(); await boot();
  for (const fixture of cases) await check(`${fixture.name}: forged moderation cannot become persisted suppression`, async () => {
    const client = await connect(fixture.code, fixture.ownerToken, fixture.ownerDevice);
    assert(last(client, 'history')?.ops?.some((op) => op.strokeId === fixture.strokeId));
    const meta = JSON.parse(await readFile(join(scratch, 'data', '.rooms', `${fixture.code}.json`), 'utf8'));
    assert.equal(meta.hiddenOpIds?.length || 0, 0);
  });
} finally {
  for (const ws of sockets) ws.terminate(); await stop();
  if (mock.listening) await new Promise((done) => mock.close(done));
  await writeFile(join(scratch, 'server.log'), log);
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ checks, syntheticDataOnly: true }, null, 2));
  console.log(`${checks.filter((check) => check.passed).length}/${checks.length} checks passed. Evidence: ${scratch}`);
  if (checks.some((check) => !check.passed)) process.exitCode = 1;
}
