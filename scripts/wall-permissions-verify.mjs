import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'drawesome-wall-permissions-'));
const data = join(scratch, 'data');
const origin = 'http://127.0.0.1:9241';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
const checks = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let child, serverLog = '';
const mock = http.createServer((req, res) => {
  const id = { 'qa-alice-token': 'qaAlice', 'qa-bob-token': 'qaBob' }[String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')];
  if (req.method === 'POST' && req.url === '/api/collections/users/auth-refresh' && id) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ record: { id, name: id, verified: true } }));
  else res.writeHead(401).end('{}');
});
async function boot(cloud = true, extraEnv = {}) {
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '9241', DATA_DIR: data, PB_URL: cloud ? 'http://127.0.0.1:9242' : '', TRUSTED_PROXY_HOSTS: '', WALL_HIDE_REPORTS: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { serverLog += chunk; }); child.stderr.on('data', (chunk) => { serverLog += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Isolated server exited');
    try { if ((await fetch(`${origin}/healthz`)).ok) return; } catch { /* startup */ }
    await sleep(100);
  }
  throw new Error('Isolated server startup timeout');
}
async function stop() { if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill('SIGTERM'); await done; } }
async function api(path, { token, device, body, method = body === undefined ? 'GET' : 'POST', ip } = {}) {
  const res = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', ...(device ? { 'x-drawesome-device-key': device } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text(); let json;
  try { json = JSON.parse(text); } catch { json = {}; }
  return { status: res.status, json, headers: res.headers };
}
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function post(key, token, extra = {}) {
  const result = await api('/api/wall', { token, body: { userKey: key, title: 'Permission fixture', frames: [png], ...extra } });
  assert.equal(result.status, 200); return result.json.id;
}
async function visible(id) {
  assert.equal((await api(`/api/wall/${id}`)).status, 200);
  assert.equal((await fetch(`${origin}/api/wall/${id}/frame/0`)).status, 200);
}
try {
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(9242, '127.0.0.1', resolve); });
  await boot();
  const anon = await post('u_qaOwnerDevice');
  const account = await post('ignored', 'qa-alice-token');
  const reportTarget = await post('u_reportOwner');
  await check('strangers cannot withdraw/delete anonymous or account-owned published artwork', async () => {
    for (const id of [anon, account]) for (const request of [{ body: {} }, { body: { userKey: 'u_stranger' } }, { body: { userKey: 'pb_qaAlice' } }, { token: 'qa-bob-token', body: { userKey: 'pb_qaAlice' } }, { token: 'invalid-token', body: { userKey: 'u_qaOwnerDevice' } }]) {
      assert([401, 403].includes((await api(`/api/wall/${id}/unpublish`, request)).status));
      assert([401, 403].includes((await api(`/api/wall/${id}`, { ...request, method: 'DELETE' })).status));
      await visible(id);
    }
  });
  await check('public metadata and raster responses do not disclose owner capabilities', async () => {
    const response = await api(`/api/wall/${anon}`);
    assert(!JSON.stringify(response.json).includes('u_qaOwnerDevice'));
    assert(!Object.hasOwn(response.json.post, 'ownerKey'));
    assert(!Object.hasOwn(response.json.post, 'userKey'));
  });
  await check('server grants withdrawal controls only to the actual anonymous device', async () => {
    for (const [key, allowed] of [['u_qaOwnerDevice', true], ['u_stranger', false], ['pb_qaAlice', false], ['', false]]) {
      const r = await api(`/api/wall/${anon}/permissions`, { body: { userKey: key } });
      assert.equal(r.status, 200); assert.equal(r.json.canUnpublish, allowed); assert.equal(r.json.canDelete, allowed);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert(!JSON.stringify(r.json).includes('u_qaOwnerDevice'));
    }
  });
  await check('account controls derive from a verified bearer identity, not the claimed owner key', async () => {
    for (const [token, allowed] of [['qa-alice-token', true], ['qa-bob-token', false], ['invalid-token', false]]) {
      const r = await api(`/api/wall/${account}/permissions`, { token, body: { userKey: 'pb_qaAlice' } });
      assert.equal(r.status, 200); assert.equal(r.json.canUnpublish, allowed); assert.equal(r.json.canDelete, allowed);
    }
  });
  await check('public reports queue for review but never grant takedown rights, even with the legacy threshold set to one', async () => {
    for (let i = 1; i <= 4; i++) {
      assert.equal((await api(`/api/wall/${reportTarget}/report`, { body: { reason: 'Synthetic review request' }, ip: `203.0.113.${i}` })).status, 200);
      await visible(reportTarget);
    }
    assert.equal((await api(`/api/wall/${reportTarget}/report`, { body: {}, ip: '203.0.113.1' })).status, 200);
    const key = (await readFile(join(data, '.admin-key'), 'utf8')).trim();
    const res = await fetch(`${origin}/api/admin/wall`, { headers: { 'x-admin-key': key } });
    const item = (await res.json()).items.find((post) => post.id === reportTarget);
    assert.equal(item.reports, 4); assert.equal(item.hidden, false);
    const queue = await fetch(`${origin}/api/admin/reports`, { headers: { 'x-admin-key': key } });
    assert((await queue.json()).reports.some((report) => report.reason.includes(reportTarget)));
  });
  await check('remix permission cannot be bypassed and remixing never mutates the original', async () => {
    assert.equal((await api(`/api/wall/${account}/remix-room`, { body: {} })).status, 404);
    const remixable = await post('u_remixOwner', undefined, { allowRemix: true });
    const response = await api(`/api/wall/${remixable}/remix-room`, { body: {} });
    assert.equal(response.status, 200); assert(response.json.code); assert.equal(response.json.remixSource.id, remixable);
    await visible(remixable);
    assert.equal((await api(`/api/wall/${remixable}/unpublish`, { body: { userKey: 'u_remixOwner' } })).status, 200);
    assert.equal((await api(`/api/wall/${remixable}/remix-room`, { body: {} })).status, 404);
  });
  await check('private account galleries reject account-id spoofing and cross-account changes', async () => {
    const saved = await api('/api/artworks', { token: 'qa-alice-token', body: { name: 'Private fixture', image: png } }); assert.equal(saved.status, 200);
    const id = saved.json.id;
    assert.equal((await api(`/api/artworks/${id}?userKey=pb_qaAlice`)).status, 401);
    assert.equal((await api(`/api/artworks/${id}`, { token: 'qa-bob-token' })).status, 404);
    await api(`/api/artworks/${id}`, { method: 'DELETE', token: 'qa-bob-token', body: { userKey: 'pb_qaAlice' } });
    assert.equal((await api(`/api/artworks/${id}`, { token: 'qa-alice-token' })).status, 200);
  });
  await check('anonymous private gallery proof travels in a header without granting account spoofing', async () => {
    const saved = await api('/api/artworks', { body: { userKey: 'u_anonGalleryOwner', name: 'Private anonymous fixture', image: png } });
    assert.equal(saved.status, 200);
    assert.equal((await api(`/api/artworks/${saved.json.id}`, { device: 'u_anonGalleryOwner' })).status, 200);
    const list = await api('/api/artworks', { device: 'u_anonGalleryOwner' });
    assert.equal(list.status, 200); assert(list.json.items.some((item) => item.id === saved.json.id));
    assert.equal((await api(`/api/artworks/${saved.json.id}`, { device: 'u_stranger' })).status, 404);
    assert.equal((await api('/api/artworks', { device: 'pb_qaAlice' })).status, 401);
    assert.equal((await api('/api/artworks', { token: 'invalid-token', device: 'u_anonGalleryOwner' })).status, 401);
  });
  await check('owners retain withdrawal and repeat withdrawal is idempotent', async () => {
    assert.equal((await api(`/api/wall/${anon}/unpublish`, { body: { userKey: 'u_qaOwnerDevice' } })).status, 200);
    assert.equal((await api(`/api/wall/${account}/unpublish`, { token: 'qa-alice-token', body: { userKey: 'not-an-owner' } })).status, 200);
    assert.equal((await api(`/api/wall/${anon}/unpublish`, { body: { userKey: 'u_qaOwnerDevice' } })).status, 200);
    assert.equal((await api(`/api/wall/${anon}`)).status, 404);
    assert.equal((await fetch(`${origin}/api/wall/${account}/frame/0`)).status, 404);
  });
  await stop(); await boot(false);
  await check('withdrawal stays enforced after restart and anonymous painting/publication remain available without cloud', async () => {
    assert.equal((await api(`/api/wall/${anon}`)).status, 404);
    const id = await post('u_unconfiguredOwner');
    await visible(id);
    assert.equal((await api(`/api/wall/${id}/unpublish`, { body: { userKey: 'u_unconfiguredOwner' } })).status, 200);
    assert.equal((await api(`/api/wall/${id}`)).status, 404);
  });
  await stop();
  // Populate real persisted fixtures rather than bypassing the route's rate limits.
  const frozenFrames = JSON.stringify([png]);
  for (let i = 0; i < 20; i++) {
    const id = `wp_capacity${i}`;
    await writeFile(join(data, '.wall', `${id}.json`), JSON.stringify({ id, title: 'Frozen artist original', artist: 'Fixture', ownerKey: 'u_frozenOwner', tags: [], createdAt: Date.now() - 72 * 3600_000 + i, frameCount: 1, votedBy: {}, reportedBy: {}, hidden: false, event: null }));
    await writeFile(join(data, '.wall', `${id}.frames.json`), frozenFrames);
  }
  await boot(false, { MAX_WALL_POSTS: '20' });
  await check('a full Wall rejects new publication rather than evicting another artist', async () => {
    const result = await api('/api/wall', { body: { userKey: 'u_capacityStranger', title: 'Capacity fixture', frames: [png] } });
    assert.equal(result.status, 409); assert.equal(result.json.error, 'wall_full');
  });
  await check('capacity pressure preserves original detail, raster and exact persisted frames', async () => {
    await visible('wp_capacity0');
    assert.equal(await readFile(join(data, '.wall', 'wp_capacity0.frames.json'), 'utf8'), frozenFrames);
    assert.equal(JSON.parse(await readFile(join(data, '.wall', 'wp_capacity0.json'), 'utf8')).ownerKey, 'u_frozenOwner');
  });
} finally {
  await stop(); if (mock.listening) await new Promise((done) => mock.close(done));
  await writeFile(join(scratch, 'server.log'), serverLog);
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ checks, syntheticDataOnly: true }, null, 2));
  console.log(`${checks.filter((item) => item.passed).length}/${checks.length} checks passed. Evidence: ${scratch}`);
  if (checks.some((item) => !item.passed)) process.exitCode = 1;
}
