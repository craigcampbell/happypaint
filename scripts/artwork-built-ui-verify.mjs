// Synthetic-only acceptance against an already-started disposable Docker image.
// Never allow the production port or a remote origin as the target.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const origin = process.env.ARTWORK_QA_ORIGIN || 'http://127.0.0.1:9261';
const url = new URL(origin);
assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port && url.port !== '8787' && url.protocol === 'http:', 'Disposable loopback origin on a non-production port required');
const scratch = await mkdtemp(join(tmpdir(), 'artwork-built-ui-'));
const checks = [], errors = [];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA6sAAAAASUVORK5CYII=';
const key = 'u_builtOwnerDevice';
let browser;
async function api(path, body, extraHeaders = {}) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function check(name, fn) { await fn(); checks.push(name); console.log(`PASS ${name}`); }
try {
  for (let i = 0; i < 80; i++) { try { if ((await api('/healthz')).status === 200) break; } catch { /* startup */ } await new Promise(r => setTimeout(r, 100)); }
  const saved = await api('/api/artworks', { userKey: key, name: 'QA private original', image: png }); assert.equal(saved.status, 200);
  const post = await api('/api/wall', { userKey: key, title: 'QA frozen ownership fixture', artist: 'Synthetic QA', frames: [png] }); assert.equal(post.status, 200);
  const id = post.data.id;
  await check('Docker runtime rejects stranger withdrawal and verifies device ownership', async () => {
    assert.equal((await api(`/api/wall/${id}/unpublish`, { userKey: 'u_builtStranger' })).status, 403);
    assert.equal((await api(`/api/wall/${id}/permissions`, { userKey: key })).data.canUnpublish, true);
    assert.equal((await api(`/api/wall/${id}/permissions`, { userKey: 'u_builtStranger' })).data.canUnpublish, false);
  });
  await check('Docker runtime reports cannot take the frozen original down', async () => {
    for (let i = 1; i <= 4; i++) {
      assert.equal((await api(`/api/wall/${id}/report`, { reason: 'Synthetic candidate authorization test' }, { 'cf-connecting-ip': `203.0.113.${i}` })).status, 200);
      assert.equal((await api(`/api/wall/${id}`)).status, 200);
    }
  });
  browser = await chromium.launch({ headless: true });
  for (const width of [375, 1280]) await check(`${width}px built stranger sees artwork but no owner management`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 812 }, serviceWorkers: 'block' });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/wall/${id}`); await page.locator('.wall-spotlight .wall-card').waitFor(); await page.waitForLoadState('networkidle');
    assert.equal(await page.getByRole('button', { name: 'Unpublish my drawing' }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Manage your drawing' }).count(), 0);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(scratch, `stranger-${width}.png`), fullPage: true }); await context.close();
  });
  await check('built owner receipt withdraws and readback denies detail and raster while private save survives', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block' });
    await context.addInitScript(value => localStorage.setItem('drawesome:userkey:v1', value), key);
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/wall/${id}`); await page.getByRole('button', { name: 'Unpublish my drawing' }).waitFor();
    await page.screenshot({ path: join(scratch, 'owner-before.png'), fullPage: true });
    page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: 'Unpublish my drawing' }).click();
    await page.getByRole('status').filter({ hasText: 'no longer public' }).waitFor();
    assert.equal((await api(`/api/wall/${id}`)).status, 404); assert.equal((await fetch(`${origin}/api/wall/${id}/frame/0`)).status, 404);
    assert.equal((await api(`/api/artworks/${saved.data.id}`, undefined, { 'x-drawesome-device-key': key })).status, 200);
    await context.close();
  });
  await check('built anonymous local easel still loads without accounts or page errors', async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } }); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/draw'); await page.locator('.overlay-canvas').waitFor({ state: 'visible' });
    assert(await page.locator('.overlay-canvas').evaluate(canvas => canvas.width > 0 && canvas.height > 0));
    assert.deepEqual(errors, []); await page.close();
  });
} finally {
  if (browser) await browser.close();
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ checks, errors, origin, syntheticDataOnly: true }, null, 2));
  console.log(`${checks.length} checks passed. Evidence: ${scratch}`);
}
