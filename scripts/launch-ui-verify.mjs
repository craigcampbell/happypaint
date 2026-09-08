// Anonymous launch smoke test against an isolated local server and real Chromium.
// Build with VITE_PB_URL and ad units empty first. No production data or payments.
/* eslint-env node, browser */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';

const out = resolve('output/playwright');
mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'drawesome-launch-ui-'));
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env, PORT: String(port), DATA_DIR: scratch, PB_URL: '',
    ROOM_DIR: join(scratch, '.rooms'), ARTWORK_DIR: join(scratch, '.artworks'), CHAT_LOG_DIR: join(scratch, '.chatlog'),
    STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', STRIPE_CHECKOUT_ENABLED: 'false',
    ENABLE_CLIENT_SNAPSHOTS: '', ADMIN_KEY: 'local-ui-verification-only',
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });
const exited = once(server, 'exit');
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
let browser;
try {
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  const requests = [];
  const sockets = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (socket) => { const entry = { url: socket.url(), closed: false }; sockets.push(entry); socket.on('close', () => { entry.closed = true; }); });
  await page.goto(base);
  await page.getByRole('button', { name: 'Start drawing', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('.home-room-meta')?.textContent.includes('drawing now'));
  await page.evaluate(() => navigator.serviceWorker.ready);
  check('375px homepage has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('Homepage defers studio and live replay downloads', !requests.some((url) => /\/assets\/(?:App|LiveRoomCanvas)-/.test(url)));
  check('No spectator connection before the preview is near the viewport', sockets.length === 0);
  check('Browser zoom remains available', !(await page.locator('meta[name="viewport"]').getAttribute('content')).includes('user-scalable=no'));
  await page.screenshot({ path: join(out, 'launch-home-phone.png'), fullPage: true });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.keyboard.press('Escape');
  check('Mobile navigation closes with Escape', await page.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded') === 'false');

  await page.locator('.home-live-preview').scrollIntoViewIfNeeded();
  await page.locator('.home-viewer canvas').waitFor();
  await page.locator('.home-viewer').click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Shift+Tab');
  check('Public-room dialog keeps keyboard focus inside', await page.evaluate(() => document.querySelector('[role="dialog"]').contains(document.activeElement)));
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector('.home-viewer canvas'));
  await page.waitForTimeout(200);
  check('Offscreen preview releases its spectator connection', sockets.length > 0 && sockets.every((s) => s.closed));
  await page.getByRole('button', { name: 'Start drawing', exact: true }).click();
  await page.locator('.studio-shell').waitFor();
  await page.locator('.load-curtain').waitFor({ state: 'hidden' });
  check('Free start opens a private anonymous room', /\/join\/[A-Z2-9]{6,8}$/.test(page.url()) && !page.url().endsWith('/MAIN'));
  const roomUrl = page.url();
  await page.waitForFunction(() => document.querySelector('.mp-dot-on'));
  // Both displays use the same viewport, so a brush stroke must change each.
  const peerContext = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const peer = await peerContext.newPage();
  await peer.goto(roomUrl);
  await peer.waitForFunction(() => document.querySelector('.mp-count')?.textContent.includes('2 painting'));
  await peer.locator('.load-curtain').waitFor({ state: 'hidden' });
  const peerBefore = await peer.locator('.display-canvas').evaluate((canvas) => canvas.toDataURL());
  await page.locator('.load-curtain').waitFor({ state: 'hidden' });
  const paper = await page.locator('.overlay-canvas').boundingBox();
  assert.ok(paper, 'Drawing surface exists');
  await page.mouse.move(paper.x + paper.width * 0.4, paper.y + paper.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(paper.x + paper.width * 0.6, paper.y + paper.height * 0.48, { steps: 12 });
  await page.mouse.up();
  await peer.waitForFunction((before) => document.querySelector('.display-canvas').toDataURL() !== before, peerBefore);
  check('A second anonymous browser receives the real painted stroke', true);
  // Exercise the real invite control while replacing only the OS share sheet;
  // no test invitation is sent to a person or to the system clipboard.
  await page.evaluate(() => Object.defineProperty(navigator, 'share', {
    configurable: true, value: async (data) => { window.testInvite = data; },
  }));
  const invite = page.locator('.studio-rooms-fab').getByRole('button', { name: 'Invite friends' });
  check('Invite friends is visible in the phone studio without opening tools', await invite.isVisible());
  await invite.click();
  check('Phone invitation shares the current room link', await page.evaluate(() => window.testInvite?.url) === roomUrl);
  check('Phone room controls fit within the viewport', await page.locator('.studio-rooms-fab').evaluate((el) => el.getBoundingClientRect().right <= innerWidth));
  await page.screenshot({ path: join(out, 'launch-studio-phone.png') });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.mobile-actions-grid').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  check('A guest can export their painting as PNG', download.suggestedFilename().endsWith('.png'));
  await download.saveAs(join(out, 'launch-test-painting.png'));

  // Toggling animation must preserve the full-size mural, including coordinates
  // beyond the rejected experimental 1920px document width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.mp-anim-toggle').click();
  await page.locator('.film-strip').waitFor();
  await peer.locator('.film-strip').waitFor();
  await page.locator('.desktop-studio-toggle').click();
  const exportDesktop = async (filename) => {
    const pending = page.waitForEvent('download');
    await page.locator('.topbar-actions').getByRole('button', { name: 'Export', exact: true }).click();
    const result = await pending;
    await result.saveAs(join(out, filename));
    return sharp(readFileSync(join(out, filename))).raw().toBuffer({ resolveWithObject: true });
  };
  const beforeAnimation = await sharp(readFileSync(join(out, 'launch-test-painting.png'))).raw().toBuffer({ resolveWithObject: true });
  const animated = await exportDesktop('launch-animation-painting.png');
  check('Animation toggle preserves 4000×2500 mural pixels', animated.info.width === 4000 && animated.info.height === 2500 && animated.data.equals(beforeAnimation.data));
  await page.locator('.topbar-close').click();
  await page.locator('.mp-anim-toggle').click();
  await page.locator('.film-strip').waitFor({ state: 'hidden' });
  await peer.locator('.film-strip').waitFor({ state: 'hidden' });
  await page.locator('.desktop-studio-toggle').click();
  const restored = await exportDesktop('launch-restored-painting.png');
  check('Disabling animation also preserves every mural pixel', restored.data.equals(beforeAnimation.data));
  await page.setViewportSize({ width: 375, height: 812 });

  await page.evaluate(() => { history.pushState({}, '', '/family'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.getByRole('button', { name: 'Subscriptions opening soon' }).waitFor();
  check('Unavailable billing blocks sign-in and purchase funnel', await page.getByRole('button', { name: 'Subscriptions opening soon' }).isDisabled());
  check('Visitors are not shown server setup instructions', !(await page.locator('main').innerText()).includes('server configuration'));
  await page.screenshot({ path: join(out, 'launch-family-phone.png'), fullPage: true });
  await page.getByRole('button', { name: 'Draw with friends for free' }).click();
  await page.locator('.studio-shell').waitFor();
  check('Unavailable subscription offers a working free private canvas', /\/join\/[A-Z2-9]{6,8}$/.test(page.url()));
  await peerContext.close();

  await page.evaluate(() => { history.pushState({}, '', '/parents'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.locator('.parents-page, .parents-main').first().waitFor();
  check('Parent guide fits 375px', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(out, 'launch-parents-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Draw something.' }).waitFor();
  check('Desktop homepage fits the viewport', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(out, 'launch-home-desktop.png'), fullPage: true });
  check('No uncaught JavaScript errors online', errors.length === 0);
  check('Anonymous run makes no ad or account service requests', !requests.some((url) => /doubleclick|googlesyndication|securepubads|pb\.drawesome|stripe\.com/.test(url)));

  await page.goto(roomUrl);
  await page.locator('.studio-shell').waitFor();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.studio-shell').waitFor();
  check('A previously visited studio opens offline from its cached shell and chunks', true);
  const cachedPaths = await page.evaluate(async () => {
    const names = await caches.keys();
    const keys = await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname)));
    return keys.flat();
  });
  check('Offline cache contains no API or billing responses', !cachedPaths.some((p) => p.startsWith('/api/') || p.startsWith('/ws')));
  writeFileSync(join(out, 'launch-ui-results.json'), JSON.stringify({ checks, errors, cachedPaths }, null, 2));
  console.log(`${checks.length} checks passed. Screenshots: ${out}`);
} catch (error) {
  console.error(error);
  console.error(serverLog.slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await exited;
}
