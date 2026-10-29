// Run with scripts/artwall-preview.mjs on 9190; isolated API/data, no cloud.
// Optional local public-art snapshot is visual evidence, not a backend test.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = 'http://127.0.0.1:9190';
const output = '/home/craig/.hermes/cache/scratch/artwall-review';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  const page = await browser.newPage();
  const errors = []; const sockets = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => { if (new URL(socket.url()).pathname === '/ws') sockets.push(socket.url()); });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/gallery', '/events', '/events/draw-for-rhoam', '/events/little-joys', '/studios']) {
      await page.goto(base + path); await page.locator('main h1').waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} overflow ${width}`);
      assert.equal(await page.locator('.discovery-sidebar:visible').count(), 0);
      assert(await page.evaluate(() => document.fonts.check('16px Anton')));
      if (path === '/') {
        await page.locator('.artwall-prompt').waitFor();
        const first = await page.locator('.artwall-prompt').innerText();
        await page.getByRole('button', { name: 'Another idea' }).click();
        const next = await page.locator('.artwall-prompt').innerText(); assert.notEqual(first, next);
        const href = await page.getByRole('link', { name: 'Draw this idea' }).getAttribute('href');
        assert.equal(new URL(href, base).searchParams.get('prompt'), next);
        await page.getByRole('link', { name: 'Draw this idea' }).click();
        await page.locator('.event-drawing-banner').waitFor();
        assert((await page.locator('.event-drawing-banner').innerText()).includes(next));
        assert.equal(sockets.length, 0, 'private canvas must not connect to shared rooms');
        await page.goto(base); await page.locator('.artwall-home').waitFor();
        if (width === 375) {
          await page.getByRole('button', { name: 'Open menu' }).click();
          assert.equal(await page.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded'), 'true');
          await page.keyboard.press('Escape'); assert.equal(await page.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded'), 'false');
        }
      }
      if (path.includes('draw-for-rhoam')) {
        assert.equal(await page.locator('[data-sensitive="true"]').count() > 0, true);
        assert.equal(await page.locator('a[href^="https://www.opb.org/"]').count(), 1);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${output}/verified-${width}-${path.replaceAll('/', '-')}.png`, fullPage: true });
      results.push({ width, path, passed: true });
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base); await page.locator('.artwall-home').waitFor();
  assert.equal(await page.locator('.artwall-draw').first().evaluate((el) => getComputedStyle(el).transitionDuration), '0s');
  await page.route('**/api/wall?**', (route) => route.fulfill({ status: 503, body: '{}' }));
  await page.reload(); await page.locator('.artwall-wall').getByRole('button', { name: 'Try again' }).waitFor();
  assert.equal(await page.locator('.artwall-wall .discovery-art-card').count(), 0);
  await page.unroute('**/api/wall?**'); await page.locator('.artwall-wall').getByRole('button', { name: 'Try again' }).click();
  await page.waitForFunction(() => !document.querySelector('.artwall-wall')?.innerText.includes('We couldn’t load'));
  assert.deepEqual(errors, []);
  console.log(`PASS ${results.length} route/viewport cases, prompt shuffle/transfer, private sockets, menu, source, reduced motion and API failure/retry`);
  await writeFile(`${output}/verification.json`, JSON.stringify({ results, errors, sockets }, null, 2));
} finally { await browser.close(); }
