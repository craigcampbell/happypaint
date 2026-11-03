// Real PageImage browser component; synthetic media/auth boundary only.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'page-image-permissions-'));
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA6sAAAAASUVORK5CYII=';
const requests = [], checks = [];
let browser, vite;
const fixture = createHttpServer((req, res) => {
  requests.push({ path: req.url, authorization: req.headers.authorization });
  const allowed = req.url === '/api/sheets/public' || req.headers.authorization === 'Bearer fixture-owner';
  res.writeHead(allowed ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(allowed ? { image: png } : { error: 'not_found' }));
});
await writeFile(join(scratch, 'auth.js'), `export async function getSession(){return window.fixtureSession;}export function onAuthStateChange(fn){window.fixtureAuth=fn;return()=>{window.fixtureAuth=null;};}`);
await writeFile(join(scratch, 'index.html'), '<div id="root"></div><script type="module" src="/entry.jsx"></script>');
await writeFile(join(scratch, 'entry.jsx'), `import React from 'react';import{createRoot}from'react-dom/client';import PageImage from ${JSON.stringify(join(root, 'src/components/PageImage.jsx'))};window.fixtureSession={user:{id:'owner'},access_token:'fixture-owner'};createRoot(document.getElementById('root')).render(<PageImage id={new URLSearchParams(location.search).get('id')||'cd_private'} alt="fixture"/>);`);
try {
  await new Promise((done, reject) => { fixture.once('error', reject); fixture.listen(9256, '127.0.0.1', done); });
  vite = await createServer({ configFile: false, envDir: scratch, root: scratch, cacheDir: join(scratch, 'vite'), plugins: [react()], resolve: { alias: [{ find: '../utils/auth', replacement: join(scratch, 'auth.js') }, { find: 'react', replacement: join(root, 'node_modules/react') }, { find: 'react-dom', replacement: join(root, 'node_modules/react-dom') }] }, server: { host: '127.0.0.1', port: 9255, strictPort: true, fs: { allow: [root, scratch, await realpath(join(root, 'node_modules'))] }, proxy: { '/api': 'http://127.0.0.1:9256' } } });
  await vite.listen(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:9255');
  await page.getByAltText('fixture').waitFor({ timeout: 5000 });
  assert(await page.getByAltText('fixture').evaluate(image => image.complete && image.naturalWidth === 1));
  assert.equal(requests.at(-1).authorization, 'Bearer fixture-owner'); checks.push('authorized private doodle fetch includes bearer and renders raster');
  const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sheets/cd_private' && response.status() === 404);
  await page.evaluate(() => { window.fixtureSession = { user: { id: 'other' }, access_token: 'fixture-other' }; window.fixtureAuth(); });
  await denied; await page.getByAltText('fixture').waitFor({ state: 'hidden' });
  assert.equal(requests.at(-1).authorization, 'Bearer fixture-other'); checks.push('account switch cannot reuse another account private image cache');
  await page.goto('http://127.0.0.1:9255?id=public'); await page.getByAltText('fixture').waitFor();
  const publicRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sheets/public' && response.request().headers().authorization === undefined);
  await page.evaluate(() => { window.fixtureSession = null; window.fixtureAuth(); }); await publicRead; await page.getByAltText('fixture').waitFor();
  assert(await page.getByAltText('fixture').evaluate(image => image.naturalWidth === 1));
  assert.equal(requests.at(-1).authorization, undefined); checks.push('ordinary public sheet still renders after logout without credentials');
  console.log(checks.map(name => `PASS ${name}`).join('\n'));
} finally {
  if (browser) await browser.close(); if (vite) await vite.close();
  if (fixture.listening) await new Promise(done => fixture.close(done));
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ checks, requests }, null, 2));
  console.log(`Evidence: ${scratch}`);
}
