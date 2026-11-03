/* global window, document, localStorage */
// Real receipt component + real server; only PocketBase identity is mocked.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'wall-owner-ui-'));
const api = 'http://127.0.0.1:9241';
const ui = 'http://127.0.0.1:9243';
const tokens = Object.fromEntries(['qaAlice', 'qaBob'].map((id) => [id, `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.qa_signature`]));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
let child, browser, vite, serverLog = '', failure = null;
const checks = [];
const mock = http.createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const id = Object.keys(tokens).find((name) => tokens[name] === token);
  if (req.method === 'POST' && req.url === '/api/collections/users/auth-refresh' && id) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ record: { id, name: id, verified: true } }));
  else res.writeHead(401).end('{}');
});
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function check(name, value) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); }
async function post(userKey, token) {
  const res = await fetch(`${api}/api/wall`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ userKey, title: 'Owner UI fixture', frames: [png] }) });
  assert.equal(res.status, 200); return (await res.json()).id;
}
try {
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(9242, '127.0.0.1', resolve); });
  child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '9241', DATA_DIR: join(scratch, 'data'), PB_URL: 'http://127.0.0.1:9242' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { serverLog += chunk; }); child.stderr.on('data', (chunk) => { serverLog += chunk; });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { ready = (await fetch(`${api}/healthz`)).ok; } catch { /* starting */ } if (ready) break; await delay(100); }
  assert(ready);
  const anon = await post('u_uiOwner'); const account = await post('ignored', tokens.qaAlice);
  let component = join(root, 'src/components/EventSharingReceipt.jsx');
  if (process.env.PERMISSION_UI_BASELINE === '1') {
    const baseline = join(scratch, 'baseline/src'); await mkdir(join(baseline, 'components'), { recursive: true });
    component = join(baseline, 'components/EventSharingReceipt.jsx');
    await writeFile(component, execFileSync('git', ['show', 'HEAD:src/components/EventSharingReceipt.jsx'], { cwd: root }));
    await symlink(join(root, 'src/utils'), join(baseline, 'utils'));
  }
  await writeFile(join(scratch, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
  await writeFile(join(scratch, 'entry.jsx'), `import React from 'react';import{createRoot}from'react-dom/client';import Receipt from ${JSON.stringify(component)};import{getPocketBase}from ${JSON.stringify(join(root, 'src/utils/auth.js'))};window.qaAuth=async(id)=>{const pb=await getPocketBase();if(id)pb.authStore.save(${JSON.stringify(tokens)}[id],{id,name:id});else pb.authStore.clear();};createRoot(document.getElementById('root')).render(<main><h1>Owner permission fixture</h1><Receipt postId={new URLSearchParams(location.search).get('post')}/></main>);`);
  vite = await createServer({ root: scratch, envDir: scratch, configFile: false, cacheDir: join(scratch, 'vite'), plugins: [react()], resolve: { alias: { react: join(root, 'node_modules/react'), 'react-dom': join(root, 'node_modules/react-dom') } }, define: { 'import.meta.env.VITE_PB_URL': JSON.stringify('http://127.0.0.1:9242') }, server: { host: '127.0.0.1', port: 9243, strictPort: true, fs: { allow: [root, scratch] }, proxy: { '/api': api } } });
  await vite.listen(); browser = await chromium.launch({ headless: true });
  const pages = [];
  async function visit(id, device = '', accountId = '') {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
    await context.addInitScript(({ device, accountId, tokens }) => { if (device) localStorage.setItem('drawesome:userkey:v1', device); if (accountId) localStorage.setItem('pocketbase_auth', JSON.stringify({ token: tokens[accountId], record: { id: accountId, name: accountId } })); }, { device, accountId, tokens });
    const page = await context.newPage(); pages.push(page); await page.goto(`${ui}/?post=${id}`); await page.locator('h1').waitFor(); await page.waitForLoadState('networkidle'); return page;
  }
  const button = (page) => page.getByRole('button', { name: 'Unpublish my drawing', exact: true });
  const stranger = await visit(anon, 'u_uiStranger');
  check('a stranger never sees owner withdrawal controls or an ownership claim', await button(stranger).count() === 0 && await stranger.getByRole('heading', { name: 'Manage your drawing' }).count() === 0);
  const empty = await visit(anon);
  check('a visitor without a device identity never sees owner controls', await button(empty).count() === 0);
  const owner = await visit(anon, 'u_uiOwner'); await button(owner).waitFor();
  check('the original anonymous device gets server-verified controls', await button(owner).isVisible());
  await owner.evaluate(() => window.qaAuth('qaBob')); await button(owner).waitFor();
  check('later sign-in preserves ownership of that same device’s anonymous post', await button(owner).isVisible());
  const accountPage = await visit(account, 'u_otherDevice', 'qaBob');
  check('a different signed-in account cannot manage another account’s drawing', await button(accountPage).count() === 0);
  await accountPage.evaluate(() => window.qaAuth('qaAlice')); await button(accountPage).waitFor();
  check('switching to the actual account owner enables controls', await button(accountPage).isVisible());
  await accountPage.evaluate(() => window.qaAuth(null)); await button(accountPage).waitFor({ state: 'hidden' });
  check('logout revokes the previous account’s visible controls', await button(accountPage).count() === 0);
  await accountPage.evaluate(() => window.qaAuth('qaBob')); await accountPage.waitForLoadState('networkidle');
  check('switching to a stranger account cannot retain stale owner controls', await button(accountPage).count() === 0);
  const forged = await visit(account, 'pb_qaAlice');
  check('claiming an account-id device key does not unlock controls', await button(forged).count() === 0);
  const outage = await browser.newContext(); const failPage = await outage.newPage();
  await failPage.addInitScript(() => localStorage.setItem('drawesome:userkey:v1', 'u_uiOwner'));
  await failPage.route('**/permissions', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await failPage.goto(`${ui}/?post=${anon}`); await failPage.waitForLoadState('networkidle');
  check('permission lookup failure fails closed with no owner controls', await button(failPage).count() === 0);
  owner.once('dialog', (dialog) => dialog.accept()); await button(owner).click();
  await owner.getByRole('status').filter({ hasText: 'no longer public' }).waitFor();
  check('the real owner can withdraw and UI verifies server removal', (await fetch(`${api}/api/wall/${anon}`)).status === 404);
  await writeFile(join(scratch, 'owner-ui.html'), await owner.content());
} catch (error) { failure = error.stack; throw error; }
finally {
  if (browser) await browser.close(); if (vite) await vite.close();
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  if (mock.listening) await new Promise((done) => mock.close(done));
  await writeFile(join(scratch, 'server.log'), serverLog);
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ passed: !failure, checks, failure, syntheticDataOnly: true }, null, 2));
  console.log(`${checks.length} checks passed${failure ? '; suite FAILED' : ''}. Evidence: ${scratch}`);
}
