// Real server, real HTML shell, scratch-only runtime/data; no shared dist or .env.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { writeTotpConfig, totp } from '../server/adminAuth.js';
import { getCuratorDefaults } from '../src/data/curatorContent.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync('/home/craig/.hermes/cache/scratch/curator-');
const runtime = join(scratch, 'runtime');
const data = join(scratch, 'data');
mkdirSync(runtime); mkdirSync(data); mkdirSync(join(runtime, 'dist'));
copyFileSync(join(root, 'server.js'), join(runtime, 'server.js'));
copyFileSync(join(root, 'package.json'), join(runtime, 'package.json'));
copyFileSync(join(root, 'index.html'), join(runtime, 'dist/index.html'));
for (const dir of ['server', 'src', 'node_modules']) symlinkSync(join(root, dir), join(runtime, dir));
const key = randomBytes(24).toString('hex');
const base = 'http://127.0.0.1:9201';
let child, exited, logs;
async function start() {
  logs = '';
  child = spawn(process.execPath, ['server.js'], { cwd: runtime, env: {
    PATH: process.env.PATH, HOME: scratch, NODE_ENV: 'test', PORT: '9201', HOST: '127.0.0.1',
    DATA_DIR: data, ADMIN_KEY: key, PB_URL: '', POCKETBASE_URL: '', AUTO_CLOSE: 'off',
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_CHECKOUT_ENABLED: 'false',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(child, 'exit');
  child.stdout.on('data', (s) => { logs += s; }); child.stderr.on('data', (s) => { logs += s; });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/healthz')).ok) return; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error('Isolated startup failed');
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Isolated startup timed out');
}
async function stop() { if (child?.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await exited; } }
async function request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const res = await fetch(base + path, { method, headers: { ...(auth ? { 'x-admin-key': key } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
try {
  await start();
  const publicDoc = await request('/api/curator/pages', { auth: false });
  assert.equal(publicDoc.status, 200, 'public Curator route exists');
  assert.deepEqual(publicDoc.body, { revision: 0, pages: Object.fromEntries(['home', 'gallery', 'events', 'studios'].map((p) => [p, getCuratorDefaults(p)])) });
  assert.equal((await request('/api/admin/curator', { auth: false })).status, 401);
  const admin = await request('/api/admin/curator');
  assert.equal(admin.status, 200);
  assert.equal(admin.body.revision, 0);
  assert.deepEqual(admin.body.pages.home.draft, getCuratorDefaults('home'));
  console.log('PASS public defaults, no-store, guarded admin read');
  const content = { ...getCuratorDefaults('home'), title: 'A <b>REAL</b>\n& new title', description: 'Escaped <script> & "words"', ctaLabel: 'Go & draw', ctaHref: '/gallery' };
  const route = '/api/admin/curator/pages/home';
  assert.equal((await request(route, { method: 'PUT', body: { revision: 0, content }, auth: false })).status, 401);
  const saved = await request(route, { method: 'PUT', body: { revision: 0, content } });
  assert.equal(saved.status, 200, 'save draft');
  assert.equal(saved.body.revision, 1);
  assert.deepEqual(saved.body.pages.home.draft, content);
  assert.deepEqual(saved.body.pages.home.published, getCuratorDefaults('home'));
  assert.deepEqual((await request('/api/curator/pages?preview=draft', { auth: false })).body.pages.home, getCuratorDefaults('home'));
  assert.ok(!(await fetch(base + '/?preview=draft').then((r) => r.text())).includes('A &lt;b&gt;REAL'), 'draft never enters initial HTML');
  assert.equal((await request(route + '/publish', { method: 'POST', body: { revision: 0 } })).status, 409);
  const published = await request(route + '/publish', { method: 'POST', body: { revision: 1 } });
  assert.equal(published.status, 200);
  assert.equal(published.body.revision, 2);
  assert.deepEqual((await request('/api/curator/pages', { auth: false })).body.pages.home, content);
  await stop(); await start();
  assert.deepEqual((await request('/api/admin/curator')).body, published.body);
  const html = await fetch(base + '/').then((r) => r.text());
  assert.ok(html.includes('<h1>A &lt;b&gt;REAL&lt;/b&gt;<br>&amp; new title</h1>'), 'published escaped initial h1');
  assert.ok(html.includes('<p>Escaped &lt;script&gt; &amp; &quot;words&quot;</p>'));
  assert.ok(html.includes('<a href="/gallery">Go &amp; draw</a>'));
  assert.ok(html.includes('rel="canonical"'));
  const reset = await request(route + '/reset', { method: 'POST', body: { revision: 2 } });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.revision, 3);
  assert.deepEqual(reset.body.pages.home.draft, getCuratorDefaults('home'));
  assert.deepEqual(reset.body.pages.home.published, getCuratorDefaults('home'));
  console.log('PASS draft isolation, conflict, publish/readback, restart, reset');
  for (const body of [null, {}, { revision: '3', content }, { revision: -1, content }, { revision: 3, content, owner: 'no' },
    { revision: 3, content: { ...content, html: '<b>no</b>' } }, { revision: 3, content: { ...content, title: 12 } },
    { revision: 3, content: { ...content, ctaHref: 'javascript:alert(1)' } }, { revision: 3, content: { ...content, ctaHref: 'https://example.com' } },
    { revision: 3, content: { ...content, palette: 'url(evil)' } }]) {
    assert.equal((await request(route, { method: 'PUT', body })).status, 400);
  }
  assert.equal((await request(route, { method: 'PUT', body: { revision: 3, content }, headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await request(route, { method: 'PUT', body: { revision: 3, content, padding: 'x'.repeat(10000) } })).status, 413);
  const invalidJson = await fetch(base + route, { method: 'PUT', headers: { 'x-admin-key': key, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  for (const page of ['unknown', '__proto__', '..%2Fhome', '%2e%2e%2fhome']) {
    assert.equal((await request('/api/admin/curator/pages/' + page, { method: 'PUT', body: { revision: 3, content } })).status, 400);
  }
  for (const action of ['publish', 'reset']) {
    assert.equal((await request(route + '/' + action, { method: 'POST', body: { revision: 3 }, auth: false })).status, 401);
    assert.equal((await request(route + '/' + action, { method: 'POST', body: { revision: 3, content } })).status, 400);
  }
  assert.equal((await request('/api/admin/curator?key=not-a-credential', { auth: false })).status, 401);
  assert.equal((await request('/api/admin/curator', { headers: { 'x-admin-key': 'wrong' } })).status, 401);
  assert.equal((await request('/api/admin/curator')).body.revision, 3);
  console.log('PASS strict fields/types/choices, traversal, JSON/size limit, auth, revision unchanged');
  // Force the atomic rename to fail without changing permissions (works as root too).
  const store = join(data, '.curator.json');
  renameSync(store, store + '.backup'); mkdirSync(store);
  assert.equal((await request(route, { method: 'PUT', body: { revision: 3, content } })).status, 503);
  assert.deepEqual((await request('/api/admin/curator')).body, reset.body);
  rmSync(store, { recursive: true }); renameSync(store + '.backup', store);
  assert.deepEqual(JSON.parse(readFileSync(store, 'utf8')), reset.body);
  console.log('PASS failed persistence leaves memory and durable document unchanged');
  // Competing global revisions across pages must have exactly one winner.
  const competing = await Promise.all(['home', 'gallery'].map((page) => request('/api/admin/curator/pages/' + page, { method: 'PUT', body: { revision: 3, content: getCuratorDefaults(page) } })));
  assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
  for (const path of ['/', '/gallery', '/events', '/studios', '/events/little-joys', '/draw']) {
    const res = await fetch(base + path); assert.equal(res.status, 200);
    const text = await res.text(); assert.ok(text.includes('data-discovery-landing')); assert.ok(text.includes('rel="canonical"'));
  }
  assert.equal((await fetch(base + '/sitemap.xml')).status, 200);
  await stop();
  writeFileSync(store, '{broken');
  await start();
  assert.deepEqual((await request('/api/curator/pages', { auth: false })).body, publicDoc.body);
  assert.match(logs, /\[curator\] Invalid store; using safe defaults/);
  await stop();
  const { config } = writeTotpConfig(data);
  await start();
  assert.equal((await request('/api/admin/curator')).status, 401, 'enrolled raw key refused');
  const login = await request('/api/admin/login', { method: 'POST', body: { key, code: totp(config.secret) }, auth: false });
  assert.equal(login.status, 200);
  const sessionHeaders = { 'x-admin-key': login.body.token };
  assert.equal((await request('/api/admin/check', { headers: sessionHeaders })).status, 200);
  assert.equal((await request('/api/admin/curator', { headers: sessionHeaders })).status, 200);
  const sessionSave = await request(route, { method: 'PUT', body: { revision: 0, content }, headers: sessionHeaders });
  assert.equal(sessionSave.status, 200);
  await stop(); await start();
  assert.deepEqual((await request('/api/admin/curator', { headers: sessionHeaders })).body, sessionSave.body);
  assert.deepEqual((await request('/api/curator/pages', { auth: false })).body.pages.home, getCuratorDefaults('home'));
  console.log('PASS competing revisions, crawlable routes/canonical/sitemap, corrupt recovery, existing 2FA session read/write');
} finally { await stop(); rmSync(scratch, { recursive: true, force: true }); }
