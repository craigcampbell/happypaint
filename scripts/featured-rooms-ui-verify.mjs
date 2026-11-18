// Isolated component/real feature-module suite, NOT combined server.js verification.
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer as httpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createServer as viteServer } from 'vite';
import { chromium } from 'playwright';
import { createFeaturedRooms } from '../server/featuredRooms.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp('/home/craig/.hermes/cache/scratch/featured-ui-');
let api, vite, browser, sockets;
try {
  await symlink(`${ROOT}node_modules`, `${scratch}/node_modules`, 'dir');
  const app = express();
  const feature = createFeaturedRooms({ dataDir: scratch, getRoomEligibility: () => ({ exists: true, audience: 'kid_safe', listed: true, hidden: false, sketchbook: false, version: 'synthetic-room:0' }) });
  feature.registerRoutes(app, (req, res) => req.get('x-admin-key') === 'fixture-admin' || (res.sendStatus(401), false));
  api = httpServer(app);
  sockets = new WebSocketServer({ server: api, path: '/ws' });
  sockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'connected', room: 'MAIN' }));
    socket.send(JSON.stringify({ type: 'history', ops: [{ kind: 'shape', tool: 'rect', start: { x: 100, y: 100 }, end: { x: 1200, y: 900 }, opts: { color: '#e7472d', fillShape: true, size: 20, opacity: 1 } }] }));
  });
  await new Promise((resolve, reject) => { api.once('error', reject); api.listen(9241, '127.0.0.1', resolve); });
  await writeFile(`${scratch}/index.html`, `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>`);
  await writeFile(`${scratch}/entry.jsx`, `import React from 'react';import{createRoot}from'react-dom/client';import Admin from '/@fs/${ROOT}src/components/AdminFeaturedRooms.jsx';import Featured from '/@fs/${ROOT}src/components/FeaturedRooms.jsx';import '/@fs/${ROOT}src/components/discovery.css';createRoot(document.getElementById('root')).render(<div className="site-page discovery-page"><main className="discovery-main"><Admin roomCode="MAIN" adminKey="fixture-admin"/><Featured/></main></div>);`);
  vite = await viteServer({ configFile: false, envFile: false, envDir: scratch, root: scratch, server: { host: '127.0.0.1', port: 9242, strictPort: true, fs: { allow: [ROOT, scratch] }, proxy: { '/api': 'http://127.0.0.1:9241', '/ws': { target: 'ws://127.0.0.1:9241', ws: true } } } });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:9242');
  await page.getByRole('button', { name: 'Preview current picture' }).click({ timeout: 20000 });
  await page.getByRole('img', { name: 'Frozen picture to feature' }).waitFor();
  assert.equal((await (await fetch('http://127.0.0.1:9241/api/featured-rooms')).json()).items.length, 0, 'preview is not publication');
  await page.getByLabel('Title (optional)').fill('A room-made picture');
  await page.getByLabel('I confirm this public-room picture is appropriate to highlight in the gallery.').check();
  await page.getByRole('button', { name: 'Feature this picture' }).click();
  await page.getByText('Picture featured in the gallery.').waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Featured from public rooms' }).waitFor();
  const image = page.locator('.featured-rooms-wall .featured-room-art img');
  await image.waitFor();
  await image.evaluate((img) => img.decode());
  assert.ok(await image.evaluate((img) => img.naturalWidth > 0));
  assert.ok(await image.evaluate((img) => { const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let painted = 0; for (let n = 0; n < pixels.length; n += 4) if (pixels[n] > 180 && pixels[n + 1] < 120 && pixels[n + 2] < 120) painted++; return painted > canvas.width * canvas.height * .1; }), 'captured raster contains actual red fixture artwork, not blank paper');
  assert.ok((await page.locator('.featured-rooms-wall').innerText()).includes('Collective work · Room MAIN'));
  const frozenUrl = await image.getAttribute('src');
  const before = Buffer.from(await (await fetch(`http://127.0.0.1:9241${frozenUrl}`)).arrayBuffer());
  for (const socket of sockets.clients) socket.send(JSON.stringify({ type: 'clear' }));
  const after = Buffer.from(await (await fetch(`http://127.0.0.1:9241${frozenUrl}`)).arrayBuffer());
  assert.deepEqual(after, before, 'ordinary room updates do not mutate selected bytes');
  assert.equal(await page.locator('.featured-room-art canvas').count(), 0, 'public feature is a frozen raster, not a live canvas');
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no overflow at ${width}`);
  }
  await page.getByRole('button', { name: 'Remove A room-made picture' }).click();
  await page.getByText('Selection removed.').waitFor();
  assert.equal((await (await fetch('http://127.0.0.1:9241/api/featured-rooms')).json()).items.length, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: preview isolation, capture/confirm/readback, decoded frozen raster, collective attribution, 375/768/1440 overflow, remove/readback; component fixture with real feature module and synthetic spectator stream.');
} finally {
  await browser?.close();
  await vite?.close();
  for (const socket of sockets?.clients || []) socket.terminate();
  if (sockets) await new Promise((resolve) => sockets.close(resolve));
  if (api?.listening) await new Promise((resolve) => api.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
