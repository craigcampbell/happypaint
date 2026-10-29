// Built React + real isolated server. Fixture admin key is generated in memory;
// no production content, environment, accounts or credentials are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium } from 'playwright';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratch = await mkdtemp('/home/craig/.hermes/cache/scratch/curator-built-');
const key = randomBytes(24).toString('hex');
const base = 'http://127.0.0.1:9221';
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { PATH: process.env.PATH, HOME: scratch, NODE_ENV: 'test', DATA_DIR: scratch, PORT: '9221', HOST: '127.0.0.1', ADMIN_KEY: key, PB_URL: '', STRIPE_CHECKOUT_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
const exit = once(child, 'exit'); let logs = ''; let browser;
child.stdout.on('data', (data) => { logs += data; }); child.stderr.on('data', (data) => { logs += data; });
try {
  let ready = false;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch { /* starting */ } await new Promise((done) => setTimeout(done, 50)); }
  assert(ready);
  browser = await chromium.launch();
  const adminContext = await browser.newContext();
  await adminContext.addInitScript((token) => sessionStorage.setItem('drawesome:adminsession:v1', JSON.stringify({ token, expiresAt: Date.now() + 3600000 })), key);
  const admin = await adminContext.newPage(); const visitor = await browser.newPage(); const errors = [];
  admin.on('pageerror', (error) => errors.push(error.message)); visitor.on('pageerror', (error) => errors.push(error.message));
  await admin.goto(base + '/admin/curator'); await admin.getByLabel('Headline', { exact: false }).waitFor();
  for (const [page, path] of [['home', '/'], ['gallery', '/gallery'], ['events', '/events'], ['studios', '/studios']]) {
    await admin.getByLabel('Page', { exact: true }).selectOption(page);
    assert(await admin.getByRole('button', { name: 'Publish saved draft', exact: true }).isDisabled(), 'unchanged published draft must not invite redundant publication');
    const original = await admin.locator('#curator-title').inputValue(); const title = `QA ${page.toUpperCase()}\nNEW HEADER`;
    await admin.locator('#curator-title').fill(title);
    await admin.getByRole('button', { name: 'Save draft', exact: true }).click();
    await admin.getByRole('status').filter({ hasText: 'Draft saved and verified' }).waitFor();
    await visitor.goto(base + path); await visitor.locator('.curated-header').waitFor();
    assert(!(await visitor.locator('h1').innerText()).includes('NEW HEADER'));
    admin.once('dialog', (dialog) => dialog.accept()); await admin.getByRole('button', { name: 'Publish saved draft', exact: true }).click();
    await admin.getByRole('status').filter({ hasText: 'Published and verified.' }).waitFor();
    await visitor.reload(); await visitor.getByRole('heading', { level: 1 }).filter({ hasText: 'NEW HEADER' }).waitFor();
    const html = await fetch(base + path, { headers: { Accept: 'text/html' } }).then((res) => res.text()); assert(html.includes('NEW HEADER'));
    assert.equal((await fetch(base + '/api/curator/pages').then((res) => res.json())).pages[page].title, title);
    admin.once('dialog', (dialog) => dialog.accept()); await admin.getByRole('button', { name: 'Restore defaults', exact: true }).click();
    await admin.getByRole('status').filter({ hasText: 'Defaults restored and verified' }).waitFor();
    assert.equal(await admin.locator('#curator-title').inputValue(), original);
    await visitor.reload(); await visitor.locator('.curated-header').waitFor(); assert(!(await visitor.locator('h1').innerText()).includes('NEW HEADER'));
    console.log(`PASS real built ${page}: draft isolation → publish → public DOM/API/HTML → reset`);
  }
  for (const width of [375, 1440]) {
    await admin.setViewportSize({ width, height: 900 }); await visitor.setViewportSize({ width, height: 900 });
    await admin.getByLabel('Page', { exact: true }).selectOption('home');
    assert(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await admin.screenshot({ path: join(scratch, `admin-${width}.png`), fullPage: true });
    for (const path of ['/', '/gallery', '/events', '/studios']) { await visitor.goto(base + path); await visitor.locator('.curated-header').waitFor(); await visitor.evaluate(() => document.fonts.ready); assert(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path); }
    await visitor.goto(base); await visitor.locator('.artwall-home').waitFor(); await visitor.evaluate(() => document.fonts.ready); await visitor.screenshot({ path: join(scratch, `home-${width}.png`), fullPage: true });
    console.log(`PASS built layout ${width}px: public headers and Curator editor`);
  }
  const unauth = await browser.newPage(); await unauth.goto(base + '/admin/curator'); await unauth.getByRole('heading', { name: 'Curator sign-in' }).waitFor(); assert.equal(await unauth.locator('#curator-title').count(), 0);
  assert.deepEqual(errors, []); console.log('PASS unauthenticated editor blocked; no browser runtime errors'); console.log('Evidence:', scratch);
} finally { if (browser) await browser.close(); if (child.exitCode === null) { child.kill('SIGTERM'); await exit; } await writeFile(join(scratch, 'server.log'), logs.replaceAll(key, '[fixture credential]')); }
