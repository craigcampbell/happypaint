/* global localStorage, sessionStorage, document, window */
// Real HTTP + browser coverage; scratch-only runtime/data, no .env, dist or production.
// Reserved ports: API 9231, Vite 9232. Never logs fixture credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, symlinkSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { writeTotpConfig, totp } from '../server/adminAuth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync('/home/craig/.hermes/cache/scratch/admin-remembered-');
const runtime = join(scratch, 'runtime'); const dataDir = join(scratch, 'data');
mkdirSync(runtime); mkdirSync(dataDir); mkdirSync(join(runtime, 'dist'));
for (const name of ['server.js', 'package.json', 'index.html']) copyFileSync(join(root, name), join(runtime, name));
copyFileSync(join(root, 'index.html'), join(runtime, 'dist/index.html'));
for (const dir of ['server', 'src']) cpSync(join(root, dir), join(runtime, dir), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(runtime, 'node_modules'));
const key = randomBytes(32).toString('hex');
const api = 'http://127.0.0.1:9231'; const web = 'http://127.0.0.1:9232';
let child, exit, browser, vite; let logs = ''; let checks = 0;
const sockets = new Set();
function check(label, value = true) { assert.ok(value, label); checks++; console.log('PASS', label); }
async function start(mode = 'test') {
  child = spawn(process.execPath, ['server.js'], { cwd: runtime, env: { PATH: process.env.PATH, HOME: scratch, NODE_ENV: mode, HOST: '127.0.0.1', PORT: '9231', DATA_DIR: dataDir, ADMIN_KEY: key, PB_URL: '', POCKETBASE_URL: '', STRIPE_CHECKOUT_ENABLED: 'false', AUTO_CLOSE: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  exit = once(child, 'exit');
  child.stdout.on('data', (s) => { logs += s; }); child.stderr.on('data', (s) => { logs += s; });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(api + '/healthz')).ok) return; } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error('Isolated startup failed');
    await new Promise((done) => setTimeout(done, 40));
  }
  throw new Error('Startup timeout');
}
async function stop() { if (child && child.exitCode === null && !child.signalCode) { child.kill('SIGTERM'); await exit; } }
async function request(path, { body, token, cookie, origin = api, method = 'POST', site } = {}) {
  const response = await fetch(api + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'x-admin-key': token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), ...(site ? { 'Sec-Fetch-Site': site } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  return { response, result };
}
function waitFrame(ws, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('WS frame timeout: ' + type)); }, 6000);
    const listener = (raw) => { const frame = JSON.parse(raw.toString()); if (frame.type === type) { cleanup(); resolve(frame); } };
    const cleanup = () => { clearTimeout(timeout); ws.off('message', listener); };
    ws.on('message', listener);
  });
}
async function socket(token, cookie) {
  const ws = new WebSocket('ws://127.0.0.1:9231/ws?room=AUTHQA&modwatch=1', { headers: cookie ? { Cookie: cookie } : {} }); sockets.add(ws);
  const result = waitFrame(ws, token ? 'connected' : 'mod_denied');
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'mod_auth', key: token || '' }));
  return { ws, frame: await result };
}
try {
  await start();
  check('unenrolled raw-key harness still works', (await request('/api/admin/check', { method: 'GET', token: key })).response.ok);
  const { config, codes } = writeTotpConfig(dataDir);
  check('raw key rejected immediately after enrollment', (await request('/api/admin/check', { method: 'GET', token: key })).response.status === 401);
  check('wrong key refused', (await request('/api/admin/login', { body: { key: 'wrong', code: totp(config.secret) } })).response.status === 401);
  check('missing code refused', (await request('/api/admin/login', { body: { key } })).result.error === 'code_required');
  const signed = await request('/api/admin/login', { body: { key, code: totp(config.secret) } });
  check('key + TOTP login succeeds', signed.response.ok);
  const cookies = signed.response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const cookie of cookies) assert.match(cookie, /HttpOnly; SameSite=Strict/i);
  check('device and authorization cookies are opaque HttpOnly Strict, dev-loopback allowed', cookies.every((s) => !s.includes('Secure')));
  const cookie = cookies.map((s) => s.split(';')[0]).join('; ');
  const deviceOnly = cookies.find((s) => s.startsWith('drawesome_admin_device=')).split(';')[0];
  check('cookie alone never authorizes admin API', (await request('/api/admin/check', { method: 'GET', cookie })).response.status === 401);
  check('remembered device alone cannot resume 2FA', (await request('/api/admin/resume', { cookie: deviceOnly })).result.error === 'code_required');
  check('same TOTP replay refused', (await request('/api/admin/login', { body: { key, code: totp(config.secret) } })).result.error === 'bad_code');
  for (const path of ['/api/admin/resume', '/api/admin/logout', '/api/admin/login']) {
    check('CSRF foreign Origin blocked: ' + path, (await request(path, { cookie, origin: 'https://evil.invalid', body: path.endsWith('login') ? { key, code: codes[9] } : undefined })).response.status === 403);
  }
  check('missing Origin blocked on cookie resume', (await request('/api/admin/resume', { cookie, origin: '' })).response.status === 403);
  check('cross-site Fetch Metadata blocked', (await request('/api/admin/resume', { cookie, site: 'cross-site' })).response.status === 403);
  const resumed = await request('/api/admin/resume', { cookie });
  check('safe resume issues header token without extending expiry', resumed.response.ok && resumed.result.expiresAt === signed.result.expiresAt);
  await stop(); await start();
  check('session and cookie resume survive server restart', (await request('/api/admin/check', { method: 'GET', token: resumed.result.token })).response.ok && (await request('/api/admin/resume', { cookie })).response.ok);
  const painter = new WebSocket('ws://127.0.0.1:9231/ws?room=AUTHQA'); sockets.add(painter);
  const connected = waitFrame(painter, 'connected'); await connected;
  const denied = await socket('', cookie); check('cookies cannot authenticate modwatch first frame', denied.frame.type === 'mod_denied');
  const mod = await socket(resumed.result.token); check('resumed token authorizes invisible watch', mod.frame.moderator && mod.frame.ghost);
  const close = once(mod.ws, 'close');
  await request('/api/admin/logout', { cookie, token: resumed.result.token });
  check('logout revokes original and resumed tokens', (await request('/api/admin/check', { method: 'GET', token: signed.result.token })).response.status === 401);
  check('logout prevents cookie resume but preserves remembered key', (await request('/api/admin/resume', { cookie })).result.remembered === true);
  await close; check('logout closes already-authorized watch socket');
  for (const ws of sockets) ws.close(); sockets.clear();
  const harness = await request('/api/admin/login', { body: { key, code: codes[7] }, origin: '' });
  check('non-browser key/code harness login remains supported', harness.response.ok);
  check('header-only harness logout needs no cookie or Origin', (await request('/api/admin/logout', { token: harness.result.token, origin: '' })).response.ok);
  check('header-only logout is durably revoked', (await request('/api/admin/check', { method: 'GET', token: harness.result.token })).response.status === 401);
  await stop(); await start('production');
  const secure = await request('/api/admin/login', { origin: 'https://127.0.0.1:9231', body: { key, code: codes[8] } });
  check('production cookies always Secure', secure.response.ok && secure.response.headers.getSetCookie().every((s) => /; Secure;/.test(s)));
  await stop(); await start();

  vite = await createServer({ configFile: false, root: runtime, envDir: scratch, cacheDir: join(scratch, 'vite-cache'), publicDir: join(root, 'public'), plugins: [react()], server: { host: '127.0.0.1', port: 9232, strictPort: true, proxy: { '/api': { target: api, changeOrigin: false }, '/ws': { target: api, ws: true, changeOrigin: false } }, fs: { allow: [runtime, root, realpathSync(join(root, 'node_modules'))] } } });
  await vite.listen();
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 375, height: 900 } });
  const errors = []; const admin = await context.newPage();
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  admin.on('pageerror', (error) => errors.push(error.message));
  await admin.goto(web + '/admin');
  await admin.getByLabel('Admin key', { exact: true }).fill(key);
  await admin.getByRole('button', { name: 'Lost your phone? Use a recovery code', exact: true }).click();
  await admin.getByLabel('Recovery code', { exact: true }).fill(codes[0]);
  await admin.getByRole('button', { name: 'Unlock', exact: true }).click();
  await admin.locator('.admin-top').waitFor();
  check('real mobile admin UI signs in using synthetic key and recovery factor');
  const browserCookies = await context.cookies();
  check('browser receives HttpOnly Strict device and grant cookies', browserCookies.filter((c) => c.name.startsWith('drawesome_admin_')).length === 2 && browserCookies.filter((c) => c.name.startsWith('drawesome_admin_')).every((c) => c.httpOnly && c.sameSite === 'Strict'));
  check('raw key never enters browser storage or readable cookies', await admin.evaluate((secret) => !JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }).includes(secret), key));
  const curator = await context.newPage();
  await curator.goto(web + '/admin/curator'); await curator.locator('#curator-title').waitFor();
  check('independent tab resumes into Curator without key or factor prompt', await curator.locator('.admin-login').count() === 0);
  await curator.reload(); await curator.locator('#curator-title').waitFor(); check('reload retains authorization');
  // Create a real anonymous room and prove watching neither joins nor counts.
  const actor = new WebSocket('ws://127.0.0.1:9231/ws?room=AUTHQA'); sockets.add(actor); await waitFrame(actor, 'connected');
  const watched = await context.newPage(); const authFrames = []; const urls = [];
  watched.on('websocket', (ws) => { urls.push(ws.url()); ws.on('framesent', ({ payload }) => { try { const f = JSON.parse(payload); if (f.type === 'mod_auth') authFrames.push(f); } catch { /* non-json */ } }); });
  await watched.goto(web + '/watch/AUTHQA'); await watched.locator('.watch-top').waitFor();
  await assert.doesNotReject(async () => { await watched.getByText('1 in the room', { exact: true }).waitFor(); });
  check('new watch tab reuses authorization and stays invisible to headcount', authFrames.length === 1 && !!authFrames[0].key);
  check('admin secrets never enter socket URLs', urls.filter((url) => new URL(url).pathname === '/ws').every((url) => !url.includes(key) && !url.includes('token=') && !url.includes('key=')));
  const browserToken = await curator.evaluate(() => JSON.parse(sessionStorage.getItem('drawesome:adminsession:v1')).token);
  const reauthorized = await curator.evaluate(async (code) => {
    const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    return response.json();
  }, codes[3]);
  check('second tab reauthorizes shared device while first tab keeps stale token', !!reauthorized.token && reauthorized.token !== browserToken);
  const logout = await curator.evaluate(async (token) => (await fetch('/api/admin/logout', { method: 'POST', headers: { 'x-admin-key': token } })).ok, browserToken);
  check('browser logout succeeds', logout);
  check('stale two-tab logout revokes newer cookie grant too', (await request('/api/admin/check', { method: 'GET', token: reauthorized.token })).response.status === 401);
  await watched.getByLabel('Authenticator code', { exact: true }).waitFor();
  check('open watch returns to factor prompt after cross-tab logout', await watched.getByLabel('Admin key', { exact: true }).count() === 0);
  const relog = await context.newPage(); await relog.goto(web + '/admin/curator');
  await relog.getByLabel('Authenticator code', { exact: true }).waitFor();
  check('remembered device needs factor but not key after logout', await relog.getByLabel('Admin key', { exact: true }).count() === 0);
  await relog.getByRole('button', { name: 'Lost your phone? Use a recovery code', exact: true }).click();
  await relog.getByLabel('Recovery code', { exact: true }).fill(codes[1]);
  await relog.getByRole('button', { name: 'Unlock', exact: true }).click(); await relog.locator('#curator-title').waitFor();
  check('code-only reauthorization succeeds on remembered device');
  await watched.locator('.watch-top').waitFor();
  check('already-open watch tab resumes when another tab reauthorizes');
  const signoutPage = await context.newPage(); await signoutPage.goto(web + '/admin');
  await signoutPage.locator('.admin-top').waitFor();
  await signoutPage.route('**/api/admin/logout', (route) => route.abort());
  let unwantedResumes = 0;
  signoutPage.on('request', (request) => { if (request.url().includes('/api/admin/resume')) unwantedResumes++; });
  await signoutPage.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signoutPage.getByRole('button', { name: 'Retry sign out', exact: true }).waitFor();
  await signoutPage.evaluate(() => window.dispatchEvent(new Event('focus')));
  await signoutPage.reload();
  await signoutPage.getByRole('button', { name: 'Retry sign out', exact: true }).waitFor();
  check('aborted logout shows deliberate retry across remount/focus/reload without resuming', unwantedResumes === 0 && await signoutPage.locator('.admin-top').count() === 0);
  await signoutPage.unroute('**/api/admin/logout');
  await signoutPage.getByRole('button', { name: 'Retry sign out', exact: true }).click();
  await signoutPage.getByRole('button', { name: 'Retry sign out', exact: true }).waitFor({ state: 'hidden' });
  await signoutPage.getByLabel('Authenticator code', { exact: true }).waitFor();
  check('real Sign out UI does not race back into cookie resume', await signoutPage.getByLabel('Admin key', { exact: true }).count() === 0);
  await relog.reload(); await relog.getByRole('button', { name: 'Forget this device', exact: true }).click();
  await relog.getByLabel('Admin key', { exact: true }).waitFor();
  check('forget-device clears cookie and requires key again', !(await context.cookies()).some((c) => c.name === 'drawesome_admin_device'));
  const outsider = await browser.newContext(); const anonymous = await outsider.newPage(); await anonymous.goto(web + '/admin/curator'); await anonymous.getByLabel('Admin key', { exact: true }).waitFor();
  check('independent browser context cannot inherit authorization', await anonymous.locator('#curator-title').count() === 0);
  // Keep a live moderator socket while rotation cannot reach disk. The watch
  // interval used to throw EISDIR here and kill the entire anonymous server.
  await relog.getByLabel('Admin key', { exact: true }).fill(key);
  await relog.getByRole('button', { name: 'Lost your phone? Use a recovery code', exact: true }).click();
  await relog.getByLabel('Recovery code', { exact: true }).fill(codes[2]);
  await relog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await relog.locator('#curator-title').waitFor();
  const rotationToken = await relog.evaluate(() => JSON.parse(sessionStorage.getItem('drawesome:adminsession:v1')).token);
  const rotationWatch = await socket(rotationToken);
  const rotationClosed = once(rotationWatch.ws, 'close');
  const blockedPath = join(dataDir, '.admin-sessions.json.tmp'); mkdirSync(blockedPath);
  writeTotpConfig(dataDir);
  await rotationClosed;
  check('rotation EISDIR closes live watch without crashing timer or anonymous app', (await fetch(api + '/healthz')).ok && child.exitCode === null);
  check('rotation persistence failure refuses all admin authorization', (await request('/api/admin/check', { method: 'GET', token: rotationToken })).response.status === 401);
  check('rotation failure keeps auth-mode endpoint alive and enrolled', (await request('/api/admin/auth-mode', { method: 'GET' })).result.totp === true);
  rmSync(blockedPath, { recursive: true });
  check('rotation retries persistence after disk recovers', (await request('/api/admin/check', { method: 'GET', token: rotationToken })).response.status === 401);
  await stop(); await start();
  check('rotation invalidation remains durable after restart', (await request('/api/admin/check', { method: 'GET', token: rotationToken })).response.status === 401);
  check('no browser runtime errors', errors.length === 0);
  console.log(`PASS ${checks} HTTP/browser checks. Evidence: ${scratch}`);
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const [i, page] of context.pages().entries()) { try { writeFileSync(join(scratch, `failure-${i}.txt`), await page.locator('body').innerText()); } catch { /* closed */ } }
  throw error;
} finally {
  for (const ws of sockets) ws.terminate();
  if (browser) await browser.close(); if (vite) await vite.close(); await stop();
  writeFileSync(join(scratch, 'server.log'), logs.replaceAll(key, '[fixture credential]'));
}
