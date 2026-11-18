/* global document, location */
// Real server, real spectator replay and decoded GIFs. Synthetic rooms/data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'drawesome-room-gallery-'));
const api = 'http://127.0.0.1:9191';
const origin = 'http://127.0.0.1:9192';
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '9191', HOST: '127.0.0.1', DATA_DIR: scratch, PB_URL: '', ENABLE_CLIENT_SNAPSHOTS: '', ENABLE_TRUSTED_CHECKPOINTS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (chunk) => { serverLog += chunk; });
child.stderr.on('data', (chunk) => { serverLog += chunk; });
let browser, vite;
const painters = [];
const checks = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function check(name, value) { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); }
async function paint(code) {
  const ws = new WebSocket(`ws://127.0.0.1:9191/ws?room=${code}`); painters.push(ws);
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'auth', token: null, userKey: `qa-room-gallery-${code}` }));
  await delay(400);
  for (let i = 0; i < 8; i++) ws.send(JSON.stringify({ type: 'op', op: { kind: 'shape', tool: 'rect', start: { x: 500 + i * 180, y: 600 + i * 90 }, end: { x: 1100 + i * 180, y: 1200 + i * 90 }, opts: { color: i % 2 ? '#ff2188' : '#02aabb', fillShape: true, size: 20, opacity: 1 } } }));
  await delay(500);
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Isolated server exited');
    try { ready = (await fetch(`${api}/healthz`)).ok; } catch { /* startup */ }
    if (ready) break;
    await delay(100);
  }
  check('isolated backend ready', ready);
  await fetch(`${api}/api/rooms/public`);
  await paint('MAIN'); await paint('DOODLE'); await paint('QAPRIVAT');
  const lobby = await (await fetch(`${api}/api/rooms/public`)).json();
  check('real public list contains drawn featured rooms but excludes the private fixture', lobby.rooms.some((r) => r.code === 'MAIN' && r.ops > 0) && lobby.rooms.some((r) => r.code === 'DOODLE' && r.ops > 0) && !lobby.rooms.some((r) => r.code === 'QAPRIVAT'));
  vite = await createServer({ root, configFile: false, envDir: scratch, cacheDir: join(scratch, 'vite'), plugins: [react()], define: { 'import.meta.env.VITE_PB_URL': JSON.stringify(''), 'import.meta.env.VITE_WS_URL': JSON.stringify('ws://127.0.0.1:9191/ws'), '__CHECKPOINT_RENDERER_VERSION__': JSON.stringify('qa-room-gallery') }, server: { host: '127.0.0.1', port: 9192, strictPort: true, proxy: { '/api': api, '/ws': { target: 'ws://127.0.0.1:9191', ws: true } } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const sockets = [], sent = [], writes = [], errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/ws') return;
    sockets.push(socket.url()); socket.on('framesent', (event) => sent.push(event.payload));
  });
  page.on('request', (req) => { if (!['GET', 'HEAD'].includes(req.method())) writes.push(req.url()); });
  await page.goto(`${origin}/gallery`); await page.locator('h1').waitFor(); await page.waitForLoadState('networkidle');
  check('normal artwork browsing opens no room spectator', sockets.length === 0);
  await page.getByRole('link', { name: 'Room shuffle', exact: true }).first().click();
  const image = page.getByRole('img', { name: /Room replay GIF/ });
  await image.waitFor({ timeout: 30000 });
  check('room gallery is opt-in and selects only public drawn rooms', ['MAIN', 'DOODLE'].includes(await page.locator('.room-remix-gallery').getAttribute('data-room-code')));
  check('make-your-own stays visible above the preview on a phone', (await page.locator('.room-remix-gallery').getByRole('link', { name: 'Make your own', exact: true }).boundingBox()).y < 500);
  check('make-your-own starts a separate blank canvas, not someone else’s room', await page.locator('.room-remix-gallery').getByRole('link', { name: 'Make your own', exact: true }).getAttribute('href') === '/draw');
  const encoded = await image.evaluate(async (img) => { const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer()); return Array.from(bytes); });
  const bytes = Buffer.from(encoded); const meta = await sharp(bytes, { animated: true }).metadata();
  check('preview is an actual bounded animated GIF, not a renamed still', bytes.subarray(0, 6).toString() === 'GIF89a' && meta.width === 320 && meta.pages > 1 && meta.pages <= 14);
  const decoded = await sharp(bytes, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frameSize = decoded.info.width * meta.pageHeight * 4;
  const hashes = new Set(Array.from({ length: meta.pages }, (_, i) => createHash('sha256').update(decoded.data.subarray(i * frameSize, (i + 1) * frameSize)).digest('hex')));
  check('decoded frames actually change as the real room strokes replay', hashes.size > 1);
  check('preview uses read-only spectator sockets and sends no drawing/chat frames', sockets.every((url) => new URL(url).searchParams.get('spectate') === '1') && sent.length === 0 && writes.length === 0);
  const first = await page.locator('.room-remix-gallery').getAttribute('data-room-code');
  await page.getByRole('button', { name: 'Shuffle room', exact: true }).click();
  await page.waitForFunction((code) => document.querySelector('.room-remix-gallery')?.dataset.roomCode !== code, first);
  await image.waitFor();
  check('shuffle chooses a different eligible room', first !== await page.locator('.room-remix-gallery').getAttribute('data-room-code'));
  for (const width of [375, 1280]) { await page.setViewportSize({ width, height: 812 }); check(`${width}px room gallery has no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
  const clearedCode = await page.locator('.room-remix-gallery').getAttribute('data-room-code');
  const oldGif = await image.getAttribute('src');
  const moderator = new WebSocket(`ws://127.0.0.1:9191/ws?room=${clearedCode}&modwatch=1`); painters.push(moderator);
  await once(moderator, 'open'); moderator.send(JSON.stringify({ type: 'mod_auth', key: (await readFile(join(scratch, '.admin-key'), 'utf8')).trim() }));
  await delay(300); moderator.send(JSON.stringify({ type: 'clear' }));
  await image.waitFor({ state: 'hidden' });
  check('a real moderation clear removes the generated replay immediately', await image.count() === 0);
  check('the old replay blob is revoked after moderation', !(await page.evaluate(async (url) => { try { await fetch(url); return true; } catch { return false; } }, oldGif)));
  moderator.terminate(); await paint(clearedCode); await image.waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload();
  await page.getByRole('img', { name: /Room preview/ }).waitFor({ timeout: 30000 });
  check('reduced motion shows a still until explicitly played', await page.getByRole('button', { name: 'Play GIF', exact: true }).isVisible());
  await page.getByRole('button', { name: 'Play GIF', exact: true }).click(); await image.waitFor();
  check('reduced-motion visitor can explicitly choose GIF playback', await image.isVisible());
  await page.locator('.room-remix-gallery').getByRole('link', { name: 'Make your own', exact: true }).click();
  await page.locator('.studio-shell').waitFor({ timeout: 30000 });
  check('make-your-own opens the anonymous local studio', new URL(page.url()).pathname === '/draw');
  check('no runtime errors', errors.length === 0);
  await writeFile(join(scratch, 'preview.gif'), bytes);
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
  for (const ws of painters) ws.terminate();
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await writeFile(join(scratch, 'server.log'), serverLog);
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ checks, evidence: scratch }, null, 2));
  console.log(`${checks.length} checks passed. Evidence: ${scratch}`);
}
