// Local regression coverage for the launch audit. No real cloud configuration
// or data is used. Run after npm run build: node scripts/launch-reliability-verify.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimClient } from '../test/harness/client.mjs';

const ROOT = process.cwd();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
let assertions = 0;
function check(name, condition) {
  assert.ok(condition, name);
  assertions += 1;
  console.log(`PASS ${name}`);
}

async function unusedPort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

async function runCase(experimental, authUrl) {
  const scratch = mkdtempSync(join(tmpdir(), 'happypaint-launch-'));
  mkdirSync(join(scratch, '.rooms'));
  const savedOps = [1, 2].map((opId) => ({
    kind: 'draw', opId, strokeId: `persisted-${opId}`, end: true,
    points: [{ x: 10 * opId, y: 20, pressure: 0.5 }],
    settings: { brush: 'round', size: 10, color: '#123456', opacity: 1 },
  }));
  for (const [room, opId] of [['PERSIST', 1], ['FUTURE', 99999999]]) {
    writeFileSync(join(scratch, `.rooms/${room}.json`), JSON.stringify({ history: savedOps, savedAt: Date.now(), audience: 'friends' }));
    writeFileSync(join(scratch, `.rooms/${room}.snap`), JSON.stringify({ opId, dataUrl: PNG }));
  }
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const clients = [];
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: scratch,
      ROOM_DIR: join(scratch, '.rooms'), ARTWORK_DIR: join(scratch, '.artworks'),
      CHAT_LOG_DIR: join(scratch, '.chatlog'), ADMIN_KEY: 'local-launch-test',
      PB_URL: experimental ? authUrl : '', POCKETBASE_URL: '',
      STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
      ENABLE_CLIENT_SNAPSHOTS: experimental ? '1' : '',
      SNAPSHOT_MIN_OPS: '1', SNAPSHOT_STALE_OPS: '1',
      SNAPSHOT_REQUEST_COOLDOWN_MS: '1', AUTO_CLOSE: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const childExited = once(child, 'exit');
  async function connect(name, token = null, room = 'ZZSNAP') {
    const client = new SimClient(`ws://127.0.0.1:${port}`, { room, name, token });
    clients.push(client);
    await client.connect();
    await client.waitFor((m) => m.type === 'history');
    return client;
  }
  async function flush(client) {
    const previous = client.all('pong').length;
    client.send({ type: 'ping' });
    await client.waitFor((m) => m.type === 'pong' && client.all('pong').length > previous);
  }
  async function draw(sender, receiver, n) {
    sender.sendOp({
      kind: 'draw', strokeId: `launch-${n}`, end: true,
      points: [{ x: n * 10, y: 20, pressure: 0.5 }],
      settings: { brush: 'round', size: 10, color: '#123456', opacity: 1 },
    });
    return (await receiver.waitFor((m) => m.type === 'op' && m.op.strokeId === `launch-${n}`)).op;
  }
  try {
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* starting */ }
      if (ready) break;
      await sleep(50);
    }
    assert.ok(ready, `Server startup timed out: ${logs}`);
    if (!experimental) {
      const hashFile = readdirSync(join(ROOT, 'dist/assets')).find((name) => /-[A-Za-z0-9_-]{8,}\.js$/.test(name));
      assert.ok(hashFile, 'Build assets exist');
      const asset = await fetch(`${base}/assets/${hashFile}`);
      check('hashed assets keep year-long immutable caching', asset.ok && asset.headers.get('cache-control')?.includes('immutable'));
      const worker = await fetch(`${base}/sw.js`);
      check('service worker revalidates on releases', worker.ok && worker.headers.get('cache-control') === 'no-cache');
      const icon = await fetch(`${base}/icon-192.png`);
      check('unhashed public files revalidate', icon.ok && icon.headers.get('cache-control') === 'no-cache');
      const missing = await fetch(`${base}/assets/missing-release.js`);
      check('missing build assets return 404 instead of HTML', missing.status === 404 && !missing.headers.get('content-type')?.includes('text/html'));
      const missingPublic = await fetch(`${base}/missing-launch-icon.png`);
      check('missing public assets return 404', missingPublic.status === 404);
      const route = await fetch(`${base}/join/ZZSNAP`);
      check('direct studio links still return the app shell', route.ok && route.headers.get('content-type')?.includes('text/html'));
    }

    const persisted = await connect('persisted-snapshot', null, 'PERSIST');
    check(experimental ? 'valid persisted snapshot loads only in experimental mode' : 'default launch ignores existing snapshot files', experimental
      ? persisted.last('snapshot')?.opId === 1 && persisted.last('history').ops.length === 1
      : !persisted.last('snapshot') && persisted.last('history').ops.length === 2);
    const future = await connect('future-snapshot', null, 'FUTURE');
    check('persisted future watermarks never hide the real room history', !future.last('snapshot') && future.last('history').ops.length === 2);
    persisted.send({ type: 'clear' });
    await flush(persisted);
    check('clearing also deletes dormant snapshot sidecars when the experiment is disabled', !existsSync(join(scratch, '.rooms/PERSIST.snap')));

    const a = await connect('first', experimental ? 'valid-host' : null);
    const b = await connect('guest');
    check(experimental ? 'mock-auth owner and anonymous guest can join together' : 'anonymous painting works with cloud unset', experimental ? a.connected.isOwner && !b.connected.profileId : !a.connected.profileId && !b.connected.profileId);
    for (const raw of ['null', 'true', '42', '"text"', '[]', '{broken']) a.ws.send(raw);
    await flush(a);
    check('malformed and primitive WebSocket frames do not crash the server', (await fetch(`${base}/healthz`)).ok);

    const first = await draw(b, a, 1);
    const last = await draw(b, a, 2);
    const sidecar = join(scratch, '.rooms/ZZSNAP.snap');
    a.send({ type: 'snapshot', opId: last.opId, dataUrl: PNG });
    await flush(a);
    check('unsolicited snapshots never write a sidecar', !existsSync(sidecar));
    const c = await connect('joiner');
    check('late join initially receives all anonymous drawing ops', c.last('history').ops.length === 2);
    if (!experimental) {
      a.send({ type: 'snapshot', opId: 99999999, dataUrl: PNG });
      await flush(a);
      check('snapshot requests stay disabled by default', clients.every((client) => client.all('snapshot_request').length === 0));
      check('disabled snapshots ignore forged future watermarks', !existsSync(sidecar));
      return;
    }

    await Promise.race([a, b].map((client) => client.waitFor((m) => m.type === 'snapshot_request')));
    const elected = [a, b].find((client) => client.last('snapshot_request'));
    const other = elected === a ? b : a;
    assert.ok(elected, 'One existing member elected');
    other.send({ type: 'snapshot', opId: last.opId, dataUrl: PNG });
    await flush(other);
    check('a different member cannot answer the elected request', !existsSync(sidecar));
    for (const opId of [99999999, first.opId, last.opId + 0.5, String(last.opId)]) {
      elected.send({ type: 'snapshot', opId, dataUrl: PNG });
      await flush(elected);
      check(`invalid snapshot watermark is rejected (${JSON.stringify(opId)})`, !existsSync(sidecar));
    }
    elected.send({ type: 'snapshot', opId: last.opId, dataUrl: 'data:image/png;base64,bm90LWFuLWltYWdl' });
    await flush(elected);
    check('fake image bytes are rejected', !existsSync(sidecar));
    const hugePng = Buffer.from(PNG.slice(PNG.indexOf(',') + 1), 'base64');
    hugePng.writeUInt32BE(50000, 16);
    elected.send({ type: 'snapshot', opId: last.opId, dataUrl: `data:image/png;base64,${hugePng.toString('base64')}` });
    await flush(elected);
    check('snapshot raster dimensions cannot exceed the full mural size', !existsSync(sidecar));
    elected.send({ type: 'snapshot', opId: last.opId, dataUrl: PNG });
    await flush(elected);
    check('one valid elected upload is accepted in experimental mode', existsSync(sidecar) && JSON.parse(readFileSync(sidecar)).opId === last.opId);
    const original = readFileSync(sidecar, 'utf8');
    elected.send({ type: 'snapshot', opId: last.opId, dataUrl: `${PNG.slice(0, -4)}AAAA` });
    await flush(elected);
    check('a consumed upload request cannot overwrite the snapshot', readFileSync(sidecar, 'utf8') === original);
    const tail = await draw(b, a, 3);
    const d = await connect('snapshot-joiner');
    check('valid snapshot reaches a late joiner', d.last('snapshot')?.opId === last.opId && d.last('snapshot')?.dataUrl === PNG);
    check('late-join tail contains exactly the newer drawing op', d.last('history').ops.length === 1 && d.last('history').ops[0].opId === tail.opId);

    // Ask for another snapshot, then invalidate its canvas before it arrives.
    await draw(b, a, 4);
    const requestCounts = new Map([a, b, c, d].map((client) => [client, client.all('snapshot_request').length]));
    await connect('trigger-refresh');
    for (let i = 0; i < 50 && ![a, b, c, d].some((client) => client.all('snapshot_request').length > requestCounts.get(client)); i += 1) await sleep(10);
    const refreshSender = [a, b, c, d].find((client) => client.all('snapshot_request').length > requestCounts.get(client));
    assert.ok(refreshSender, 'Refresh request exists');
    a.send({ type: 'clear' });
    await flush(a);
    refreshSender.send({ type: 'snapshot', opId: tail.opId + 1, dataUrl: PNG });
    await flush(refreshSender);
    const e = await connect('after-clear');
    check('clear cancels pending uploads and removes the stored snapshot', !existsSync(sidecar) && !e.last('snapshot') && e.last('history').ops.length === 0);
  } catch (error) {
    error.message += `\nServer output:\n${logs}`;
    throw error;
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    if (child.exitCode === null) child.kill();
    await childExited;
    const target = resolve(scratch);
    const allowedPrefix = `${resolve(tmpdir())}\\happypaint-launch-`.replace(/\\/g, '/');
    assert.ok(target.replace(/\\/g, '/').startsWith(allowedPrefix), 'Cleanup stays inside its generated temporary directory');
    rmSync(target, { recursive: true, force: true });
  }
}

const mockAuth = createServer((req, res) => {
  const valid = req.method === 'POST' && req.url === '/api/collections/users/auth-refresh' && req.headers.authorization === 'valid-host';
  res.writeHead(valid ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(valid ? { record: { id: 'launch-test-host', name: 'Host' } } : {}));
});
try {
  mockAuth.listen(0, '127.0.0.1');
  await once(mockAuth, 'listening');
  await runCase(false, '');
  await runCase(true, `http://127.0.0.1:${mockAuth.address().port}`);
  console.log(`Launch reliability checks passed (${assertions} assertions).`);
} finally {
  await new Promise((done) => mockAuth.close(done));
}
