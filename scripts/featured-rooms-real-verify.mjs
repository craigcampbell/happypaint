/* global sessionStorage, document, innerWidth */
// Real server + actual app (scratch built bundle and Vite); never deployment data/env.
// Reserved API 9251, Vite 9252. Synthetic auth only; no secret output.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, symlinkSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as httpServer } from 'node:http';
import { WebSocket } from 'ws';
import { build, createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { writeTotpConfig } from '../server/adminAuth.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(root, '/home/craig/Projects/happypaint-artwall-20261026');
const scratch = mkdtempSync('/home/craig/.hermes/cache/scratch/featured-real-');
const runtime = join(scratch, 'runtime'), data = join(scratch, 'data');
mkdirSync(runtime); mkdirSync(join(data, '.rooms'), { recursive: true });
for (const f of ['server.js', 'package.json', 'index.html']) copyFileSync(join(root, f), join(runtime, f));
for (const f of ['src', 'server']) cpSync(join(root, f), join(runtime, f), { recursive: true });
symlinkSync(join(root, 'node_modules'), join(runtime, 'node_modules'));
const api = 'http://127.0.0.1:9251', dev = 'http://127.0.0.1:9252';
const key = randomBytes(32).toString('hex');
const paint = { kind: 'shape', tool: 'rect', start: { x: 100, y: 100 }, end: { x: 2200, y: 1500 }, opts: { color: '#e7472d', fillShape: true, size: 20, opacity: 1 }, opId: 1, userId: 'fixture', ts: Date.now() };
function seed(code, extra = {}) { writeFileSync(join(data, '.rooms', code + '.json'), JSON.stringify({ audience: 'kid_safe', listed: true, createdAt: Date.now(), savedAt: Date.now(), featuredVersion: randomBytes(24).toString('hex'), history: [paint], ...extra })); }
seed('ARTQA'); seed('LEGACY', { featuredVersion: undefined }); seed('FRIEND', { audience: 'friends' }); seed('UNLISTED', { listed: false });
seed('BOOKQA', { sketchbook: { book: 'sb_0123456789abcdef', day: 1, prompt: 'Synthetic book', date: '2026-10-01' } });
seed('PUBBOOK', { audience: 'artist_public', gallery: { listed: true, publishedAt: new Date().toISOString() }, sketchbook: { book: 'sb_0123456789abcdef', day: 2 } });
seed('UNSAVED', { sketchbook: { book: 'sb_0123456789abcdef', day: 3 } });
seed('DRAFT', { audience: 'artist_public', gallery: { listed: false } });
seed('HIDDEN', { audience: 'artist_public', gallery: { listed: true, publishedAt: new Date().toISOString(), moderationHidden: true } });
seed('ARTIST', { audience: 'artist_public', listed: false, ownerProfileId: 'fixture-owner', gallery: { listed: true, publishedAt: new Date().toISOString() } });
seed('LONG_CODE-123456'); seed('OWNED', { ownerProfileId: 'fixture-owner' });
let currentPage;
let child, exit, browser, vite, mock, mockOrigin = '', token = key, checks = 0, logs = '';
const sockets = new Set();
const wait = (n) => new Promise((r) => setTimeout(r, n));
function check(label, value = true) { assert.ok(value, label); checks++; console.log('PASS', label); }
async function req(path, { method = 'GET', body, auth = true, bearer } = {}) {
  const response = await fetch(api + path, { method, headers: { ...(auth ? { 'x-admin-key': token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(bearer ? { Authorization: 'Bearer synthetic-profile' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, body: await response.json().catch(() => ({})) };
}
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: runtime, env: { PATH: process.env.PATH, HOME: scratch, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '9251', DATA_DIR: data, ADMIN_KEY: key, PB_URL: mockOrigin, POCKETBASE_URL: '', AUTO_CLOSE: 'off', STRIPE_CHECKOUT_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  exit = once(child, 'exit'); child.stdout.on('data', (s) => { logs += s; }); child.stderr.on('data', (s) => { logs += s; });
  for (let i = 0; i < 250; i++) { try { if ((await fetch(api + '/healthz')).ok) return; } catch { /* boot */ } if (child.exitCode !== null) throw new Error('Server exited'); await wait(40); }
  throw new Error('Server startup timeout');
}
async function stop() { for (const ws of sockets) ws.terminate(); sockets.clear(); if (child?.exitCode === null) { child.kill('SIGTERM'); await exit; } }
async function socket(code, moderator = false, profile = false) {
  const ws = new WebSocket(`ws://127.0.0.1:9251/ws?room=${code}${moderator ? '&modwatch=1' : ''}`); sockets.add(ws);
  const connected = frame(ws, 'connected'); await once(ws, 'open'); ws.send(JSON.stringify(moderator ? { type: 'mod_auth', key: token } : { type: 'auth', token: profile ? 'synthetic-profile' : null })); await connected; return ws;
}
function frame(ws, type) { return new Promise((resolve, reject) => { const timeout = setTimeout(() => { ws.off('message', listener); reject(new Error('WS timeout ' + type)); }, 10000); const listener = (raw) => { const msg = JSON.parse(raw); if (msg.type === type) { clearTimeout(timeout); ws.off('message', listener); resolve(msg); } }; ws.on('message', listener); }); }
const png = 'data:image/png;base64,' + (await sharp({ create: { width: 32, height: 32, channels: 3, background: '#e7472d' } }).png().toBuffer()).toString('base64');
async function publish(code = 'ARTQA') { const source = await req('/api/admin/featured-rooms/source/' + code); assert.equal(source.response.status, 200); const result = await req('/api/admin/featured-rooms', { method: 'POST', body: { roomCode: code, version: source.body.version, title: 'Synthetic selection', confirmed: true, image: png } }); assert.equal(result.response.status, 201, JSON.stringify(result.body)); return result.body.item; }
async function absent(item) { assert.equal((await fetch(api + item.imageUrl)).status, 404); assert.ok(!(await req('/api/featured-rooms', { auth: false })).body.items.some((i) => i.id === item.id)); }
try {
  await build({ configFile: false, root: runtime, envDir: scratch, cacheDir: join(scratch, 'vite-cache'), publicDir: join(root, 'public'), plugins: [react()], build: { outDir: join(runtime, 'dist') } });
  await start();
  check('unconfigured anonymous API public reads', (await req('/api/featured-rooms', { auth: false })).response.ok);
  const anon = await socket('ARTQA'); check('unconfigured anonymous painter connects', anon.readyState === WebSocket.OPEN);
  check('all feature admin routes reject missing auth', (await req('/api/admin/featured-rooms', { auth: false })).response.status === 401);
  for (const code of ['FRIEND', 'UNLISTED', 'BOOKQA', 'PUBBOOK', 'UNSAVED', 'DRAFT', 'HIDDEN', 'ABSENT']) check('authoritative source denies ' + code, (await req('/api/admin/featured-rooms/source/' + code)).response.status === 403);
  check('absent eligibility does not create room', !existsSync(join(data, '.rooms/ABSENT.json')));
  check('server-supported long underscore/hyphen code preserved', (await req('/api/admin/featured-rooms/source/LONG_CODE-123456')).response.ok);
  const legacy = await publish('LEGACY'); await socket('LEGACY');
  check('legacy dormant epoch matches materialized source', (await fetch(api + legacy.imageUrl)).status === 200);
  await req('/api/admin/featured-rooms/' + legacy.id, { method: 'DELETE' });
  let item = await publish();
  const before = Buffer.from(await (await fetch(api + item.imageUrl)).arrayBuffer());
  const peer = await socket('ARTQA');
  const echo = frame(peer, 'op'); anon.send(JSON.stringify({ type: 'op', op: { ...paint, opId: undefined, start: { x: 2400, y: 1800 }, end: { x: 2900, y: 2200 } } })); await echo;
  check('ordinary drawing preserves exact frozen raster', before.equals(Buffer.from(await (await fetch(api + item.imageUrl)).arrayBuffer())));
  await stop(); await start();
  check('persisted selection survives real restart', (await fetch(api + item.imageUrl)).status === 200);
  const mod = await socket('ARTQA', true);
  let history = frame(mod, 'history'); mod.send(JSON.stringify({ type: 'mod_hide', opIds: [1] })); await history; await absent(item);
  check('moderation hide withdraws listing and raster');
  history = frame(mod, 'history'); mod.send(JSON.stringify({ type: 'mod_restore', opIds: [1] })); await history; await absent(item);
  check('moderation restore cannot resurrect old selection');
  item = await publish(); history = frame(mod, 'history'); mod.send(JSON.stringify({ type: 'mod_remove', opIds: [1] })); await history; await absent(item); check('permanent moderation removal withdraws');
  item = await publish(); await req('/api/admin/rooms/ARTQA/delete', { method: 'POST' }); await absent(item);
  await socket('ARTQA'); await absent(item); check('deletion and recreation cannot resurrect');
  await stop();
  // Reset only this disposable fixture for the real UI source image.
  seed('ARTQA'); writeFileSync(join(data, '.rooms/ARTQA.history.json'), JSON.stringify([paint])); writeFileSync(join(data, '.rooms/ARTQA.ops.jsonl'), ''); await start();
  const { codes } = writeTotpConfig(data);
  check('raw key rejected by enrolled feature guard', (await req('/api/admin/featured-rooms')).response.status === 401);
  const login = await req('/api/admin/login', { method: 'POST', auth: false, body: { key, code: codes[0] } }); assert.equal(login.response.status, 200); token = login.body.token;
  check('existing session token authorizes feature routes', (await req('/api/admin/featured-rooms')).response.ok);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 900 } });
  await context.addInitScript(({ token, expiresAt }) => sessionStorage.setItem('drawesome:adminsession:v1', JSON.stringify({ token, expiresAt })), { token, expiresAt: login.body.expiresAt });
  const page = await context.newPage(); currentPage = page; const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(api + '/watch/ARTQA');
  await page.getByRole('button', { name: 'Preview current picture' }).click({ timeout: 40000 });
  await page.getByRole('img', { name: 'Frozen picture to feature' }).waitFor();
  await page.screenshot({ path: join(scratch, 'built-preview-phone.png'), fullPage: true });
  check('built RoomWatch preview stays unpublished', (await req('/api/featured-rooms', { auth: false })).body.items.length === 0);
  await page.getByLabel('Title (optional)').fill('Real browser collective');
  await page.getByLabel('I confirm this public-room picture is appropriate to highlight in the gallery.').check();
  await page.getByRole('button', { name: 'Feature this picture' }).click();
  await page.getByText('Picture featured in the gallery.').waitFor();
  item = (await req('/api/featured-rooms', { auth: false })).body.items[0]; assert.ok(item);
  check('built RoomWatch explicit publish verified through public API');
  const publicContext = await browser.newContext({ viewport: { width: 375, height: 900 } });
  const gallery = await publicContext.newPage(); let publicSockets = 0; gallery.on('websocket', () => publicSockets++);
  await gallery.goto(api + '/gallery');
  const image = gallery.locator('.featured-rooms-wall .featured-room-art img'); await image.waitFor({ timeout: 30000 }); await image.evaluate((img) => img.decode());
  await gallery.screenshot({ path: join(scratch, 'built-gallery-phone.png'), fullPage: true });
  check('built anonymous gallery renders decoded raster', await image.evaluate((img) => img.naturalWidth > 0));
  check('built capture contains red actual real-server replay pixels', await image.evaluate((img) => { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let red = 0; for (let n = 0; n < d.length; n += 4) if (d[n] > 180 && d[n+1] < 120 && d[n+2] < 120) red++; return red > c.width * c.height * .1; }));
  check('anonymous featured gallery opens no sockets or canvases', publicSockets === 0 && await gallery.locator('.featured-rooms-wall canvas').count() === 0);
  for (const width of [375, 768, 1440]) { await gallery.setViewportSize({ width, height: 900 }); check('built gallery no overflow ' + width, await gallery.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
  await gallery.screenshot({ path: join(scratch, 'built-gallery-desktop.png'), fullPage: true });
  await page.goto(api + '/admin/curator'); await page.getByRole('button', { name: 'Remove Real browser collective' }).click({ timeout: 30000 }); await page.getByText('Selection removed.').waitFor(); await absent(item); check('built Curator management removes and verifies raster withdrawal');
  check('no built UI page errors', errors.length === 0);
  vite = await createVite({ configFile: false, root: runtime, envDir: scratch, cacheDir: join(scratch, 'vite-dev-cache'), publicDir: join(root, 'public'), plugins: [], server: { host: '127.0.0.1', port: 9252, strictPort: true, fs: { allow: [runtime, root, realpathSync(join(root, 'node_modules'))] }, proxy: { '/api': { target: api, changeOrigin: false }, '/ws': { target: api, ws: true, changeOrigin: false } } } }); await vite.listen();
  await page.goto(dev + '/watch/FRIEND'); await page.getByRole('heading', { name: 'Feature a public-room picture' }).waitFor({ timeout: 30000 });
  check('Vite private RoomWatch never opens public capture', await page.getByRole('button', { name: 'Preview current picture' }).count() === 0 && await page.locator('.admin-featured-viewport canvas').count() === 0);
  await browser.close(); browser = null; await vite.close(); vite = null;
  await stop();
  mock = httpServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ record: { id: 'fixture-owner' } })); }); await new Promise((r) => mock.listen(0, '127.0.0.1', r)); mockOrigin = 'http://127.0.0.1:' + mock.address().port;
  await start();
  item = await publish('ARTIST');
  assert.equal((await req('/api/admin/rooms/ARTIST/unpublish', { method: 'POST' })).response.status, 200); await absent(item);
  assert.equal((await req('/api/admin/rooms/ARTIST/restore', { method: 'POST' })).response.status, 200); await absent(item);
  check('artist moderation hide/restore cannot resurrect selection');
  await stop(); await start(); await absent(item); check('restored moderation remains withdrawn after restart');
  item = await publish('ARTIST');
  const withdrawn = await req('/api/rooms/ARTIST/unpublish', { method: 'POST', bearer: true }); assert.equal(withdrawn.response.status, 200); await absent(item); check('real owner publication withdrawal revokes frozen selection');
  await stop(); await start(); await absent(item); check('privacy withdrawal remains removed after restart');
  // Physically verify account erasure against durable metadata and raster files.
  const actor = await socket('LONG_CODE-123456', false, true);
  const observer = await socket('LONG_CODE-123456'); const drawn = frame(observer, 'op');
  actor.send(JSON.stringify({ type: 'op', op: { ...paint, opId: undefined } })); await drawn;
  item = await publish('LONG_CODE-123456');
  const owned = await publish('OWNED'); const unrelated = await publish('ARTQA');
  await stop(); await start();
  const erasure = await req('/api/account/scrub-chat', { method: 'POST', bearer: true });
  assert.equal(erasure.response.status, 200, JSON.stringify(erasure.body)); await absent(item);
  await absent(owned);
  check('account erasure preserves unrelated selections', (await fetch(api + unrelated.imageUrl)).status === 200);
  check('account erasure physically removes owned row and raster', !JSON.parse(readFileSync(join(data, '.featured-rooms/index.json'))).items.some((i) => i.id === owned.id) && !existsSync(join(data, '.featured-rooms', owned.id + '.webp')));
  check('account erasure physically removes contributor row and raster', !JSON.parse(readFileSync(join(data, '.featured-rooms/index.json'))).items.some((i) => i.id === item.id) && !existsSync(join(data, '.featured-rooms', item.id + '.webp')));
  console.log(`PASS ${checks} real-server/built-browser assertions. Scratch evidence: ${scratch}`);
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    await currentPage.screenshot({ path: join(scratch, 'failure.png'), fullPage: true }).catch(() => {});
    writeFileSync(join(scratch, 'failure-dom.txt'), await currentPage.locator('body').innerText().catch(() => 'DOM unavailable'));
  }
  writeFileSync(join(scratch, 'failure.txt'), String(error.stack)); console.error('Evidence:', scratch); throw error;
} finally {
  await browser?.close(); await vite?.close(); await stop(); if (mock) await new Promise((r) => mock.close(r)); writeFileSync(join(scratch, 'server.log'), logs);
}
