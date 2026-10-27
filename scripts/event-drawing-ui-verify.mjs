/* global window, localStorage */
// Real studio + real API, isolated from production. No build required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = mkdtempSync(path.join(process.env.TMPDIR || '/home/craig/.hermes/cache/scratch', 'event-drawing-'));
const API = 'http://127.0.0.1:9171';
const BASE = 'http://127.0.0.1:9172';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: '9171', DATA_DIR: DATA, PB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (d) => { logs += d; });
child.stderr.on('data', (d) => { logs += d; });
let vite, browser, wallReceipt;
// Explicit isolated REST bridge: Vite never proxies to production defaults.
const bridge = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fetch(`${API}${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (req.method === 'POST' && req.url === '/api/wall' && response.ok) wallReceipt = JSON.parse(bytes.toString());
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
    res.end(bytes);
  } catch (error) { res.writeHead(502).end(String(error)); }
});
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${name}`); };
try {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(`${API}/healthz`)).ok) break; } catch { /* starting */ }
    await delay(200);
  }
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(9173, '127.0.0.1', resolve); });
  process.env.VITE_WS_URL = 'ws://127.0.0.1:9171/ws';
  process.env.VITE_PB_URL = '';
  vite = await createServer({ root: ROOT, server: { port: 9172, strictPort: true, host: '127.0.0.1', hmr: false, proxy: { '/api': 'http://127.0.0.1:9173' } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('happypaint:welcomed:v1', 'true');
    // A prior watchable room must not open a cross-room watcher in local mode.
    localStorage.setItem('happypaint:recent-rooms:v1', JSON.stringify([{ code: 'OLDTEST', watchName: 'Artist', mentionKey: 'test' }]));
  });
  const page = await context.newPage();
  const sockets = [], writes = [], errors = [];
  // Vite's development client still attempts its tooling socket with hmr:false.
  // Count application sockets separately; production has no Vite client.
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.port === '9172' && url.pathname === '/' && url.searchParams.has('token')) return;
    sockets.push(socket.url());
  });
  page.on('request', (req) => { if (req.method() !== 'GET' && req.method() !== 'HEAD') writes.push({ url: req.url(), body: req.postDataJSON() }); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/draw?event=draw-for-rhoam`);
  await page.waitForSelector('.event-drawing-banner');
  await page.waitForFunction(() => window.__drawesomeCheckpoint?.layers().length > 0);
  const welcome = page.locator('.welcome-go');
  if (await welcome.isVisible()) await welcome.click();
  check('local banner and prompt', (await page.locator('.event-drawing-banner').innerText()).includes('Draw for Rhoam'));
  check('no room loading curtain', await page.locator('.room-loading-curtain').count() === 0);
  const pixels = () => page.evaluate(() => {
    const canvas = window.__drawesomeCheckpoint.layers()[0].canvas;
    const bytes = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0; for (let i = 3; i < bytes.length; i += 4) sum += bytes[i]; return sum;
  });
  const before = await pixels();
  // Real pointer handlers on the studio's overlay, not a direct pixel fixture.
  const target = page.locator('.overlay-canvas');
  const box = await target.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * .35, box.y + box.height * .45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .6, { steps: 15 });
  await page.mouse.up();
  await delay(700);
  check('actual drawing changes layer pixels', await pixels() > before);
  await page.waitForFunction(async () => {
    const { idbGet } = await import('/src/utils/idb.js');
    return Boolean((await idbGet('draft:v4:local:draw-for-rhoam'))?.layers?.length);
  });
  check('private draft uses existing room-scoped IndexedDB store', true);
  await page.locator('.desktop-studio-toggle').click();
  await page.locator('#desktop-studio-menu').getByRole('button', { name: '💾 Save', exact: true }).click();
  await page.waitForFunction(async () => {
    const { idbGetKV } = await import('/src/utils/idb.js');
    return (await idbGetKV('gallery:v2'))?.length > 0;
  });
  await page.getByRole('button', { name: 'Close studio actions', exact: true }).click();
  check('Save keeps art in the existing local gallery without upload', writes.length === 0);
  console.log('Local network audit', JSON.stringify({ sockets, writes }));
  check('zero WebSockets in private drawing', sockets.length === 0);
  check('no POST or other writes before consent', writes.length === 0);
  await page.getByRole('button', { name: 'Share to event', exact: true }).click();
  await page.waitForSelector('.wall-post-modal');
  check('preview is rendered', await page.locator('.wall-post-preview img').evaluate((img) => img.complete && img.naturalWidth > 0));
  check('public confirmation required', await page.getByRole('button', { name: 'Pin it! 🧲' }).isDisabled());
  check('sensitive event has no remix option', await page.getByLabel('Let other artists remix this drawing').count() === 0);
  await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  check('cancel does not publish', writes.length === 0);
  await page.getByRole('button', { name: 'Share to event', exact: true }).click();
  await page.getByLabel('I want to publish this picture publicly').check();
  const responsePromise = page.waitForResponse((res) => res.url().endsWith('/api/wall') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Pin it! 🧲' }).click();
  const response = await responsePromise;
  const receipt = wallReceipt;
  check('real API accepts public picture', response.ok() && Boolean(receipt.id));
  const payload = writes.find((req) => req.url.endsWith('/api/wall')).body;
  check('explicit event, no room and no sensitive remix', payload.event === 'draw-for-rhoam' && payload.room === null && payload.allowRemix === false && payload.parentPostId === null);
  check('local owner device key initialized without socket', Boolean(payload.userKey));
  await page.waitForURL(`**/events/draw-for-rhoam?post=${receipt.id}`);
  check('receipt navigates to event contribution', page.url().includes(`?post=${receipt.id}`));
  const stored = await fetch(`${API}/api/wall/${encodeURIComponent(receipt.id)}`);
  check('published target can be read back', stored.ok);
  await page.getByRole('heading', {name:'Your sharing receipt'}).waitFor();
  await page.getByText('My drawing', {exact:true}).waitFor();
  check('real contribution is visible in its event', true);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', {name:'Unpublish my drawing'}).click();
  await page.getByRole('status').filter({hasText:'no longer public'}).waitFor();
  check('real UI retraction removes public frame', (await fetch(`${API}/api/wall/${receipt.id}/frame/0`)).status === 404);
  await page.goto(`${BASE}/inktober?post=${receipt.id}`);
  await page.getByRole('heading', {name:'Your sharing receipt'}).waitFor();
  check('seasonal event also supports the sharing receipt', true);
  await page.getByRole('link', {name:'Draw my own, privately'}).click();
  await page.waitForSelector('.event-drawing-banner');
  check('Inktober offers private participation without guest room creation', page.url().includes('/draw?event=inktober-2026'));
  await page.goto(`${BASE}/draw?event=not-a-real-event`);
  await page.waitForSelector('.event-drawing-banner');
  check('unknown event falls back to anonymous private canvas', (await page.locator('.event-drawing-banner').innerText()).includes('quiet canvas'));
  await page.goto(`${BASE}/draw`);
  await page.waitForSelector('.event-drawing-banner');
  check('draw without event works with cloud unset', (await page.locator('.event-drawing-banner').innerText()).includes('Just you'));
  await page.setViewportSize({ width: 375, height: 812 });
  await delay(300);
  const bannerBox = await page.locator('.event-drawing-banner').boundingBox();
  const fabBox = await page.locator('.studio-rooms-fab').boundingBox();
  const shareBox = await page.getByRole('button', { name: 'Share to Wall', exact: true }).boundingBox();
  check('mobile privacy and share action do not overlap room navigation', Boolean(bannerBox && fabBox && shareBox && shareBox.y >= fabBox.y + fabBox.height));
  await page.screenshot({ path: path.join(DATA, 'private-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  check('all local visits remain socket-free', sockets.length === 0);
  await page.goto(`${BASE}/join/LOCALTST`);
  await page.waitForFunction(() => window.__drawesomeCheckpoint?.joinStep() >= 2);
  console.log('Room socket audit', JSON.stringify(sockets));
  check('ordinary anonymous room still connects to isolated server', sockets.some((url) => url.startsWith('ws://127.0.0.1:9171/ws') && url.includes('LOCALTST')));
  check('no browser runtime errors', errors.length === 0);
  await context.close();
  console.log(`Verified against scratch DATA_DIR ${DATA}`);
} finally {
  await browser?.close();
  await vite?.close();
  bridge.closeAllConnections();
  await new Promise((resolve) => bridge.listening ? bridge.close(resolve) : resolve());
  if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
}
