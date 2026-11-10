/* global window */
// Account partition integration: execute the real App save callback, then browser checks.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { parse } = require('espree');
const text = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
function callback(name) {
  let found;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.name === name && node.init?.type === 'CallExpression') found = text.slice(...node.init.arguments[0].range);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else walk(value);
  }
  walk(ast); assert.ok(found, name); return found;
}
const labelled = [{ id: 'new', cloudOwner: 'A', name: 'private A' }];
let state, pushed = 0;
const context = {
  layersRef: { current: [{}] }, galleryRef: { current: [] }, gallerySessionRef: { current: 'A' }, galleryEpochRef: { current: 1 },
  composeCanvas: async () => ({}), canvasToDataUrl: async () => 'data:image/png;base64,',
  makeId: () => 'new', todayName: () => 'today', initialLocal: false, selectedTexture: 'linen', MAX_GALLERY_ITEMS: 20,
  getVisibleGallery: (items, owner) => items.filter(item => !item.cloudOwner || item.cloudOwner === owner),
  persistGallery: async () => labelled, setGallery: (items) => { state = items; }, setStatus() {},
  signalNaturalAdBreak() {}, schedulePush: () => { pushed++; },
};
const save = vm.runInNewContext(`(${callback('saveToGallery')})`, context);
await save();
assert.equal(state?.[0]?.cloudOwner, 'A', 'App must adopt owner-labelled persist result, not its unlabelled input');
assert.equal(context.galleryRef.current, state, 'ref and React state share committed result');
console.log('PASS save adopts labelled persistence result');
state = undefined;
context.persistGallery = async () => false;
await save();
assert.equal(state, undefined, 'invalidated persistence must never update UI');
assert.equal(pushed, 1, 'invalidated save must not schedule upload');
console.log('PASS invalidated save does not update UI or upload');
assert.ok(!text.includes('GALLERY_IDB_KEY'), 'App must not bypass partition-aware storage');
assert.ok(text.includes('onGalleryChange('), 'App must observe background pulls');
console.log('PASS partition-aware storage subscription');
for (const match of text.matchAll(/fetch\(`\/api\/(?:audio|sheets)\/[^\n]+/g)) {
  assert.ok(match[0].includes('headers: filmAuthHeaders('), `protected media bearer missing: ${match[0]}`);
  assert.ok(match[0].includes('cache: "no-store"'), 'private media must not use reusable cache');
}
console.log('PASS all protected media fetches use bearer and no-store');
let resolveList;
let serverRows;
const serverContext = {
  userKeyRef: { current: 'pb_A' }, tokenRef: { current: 'A', epoch: 1 },
  fetch: () => new Promise(resolve => { resolveList = resolve; }),
  setMyDrawings: rows => { serverRows = rows; }, setSavesMax() {},
};
const list = vm.runInNewContext(`(${callback('loadMyDrawings')})`, serverContext);
const pendingList = list();
serverContext.userKeyRef.current = 'pb_B'; serverContext.tokenRef.current = 'B'; serverContext.tokenRef.epoch++;
resolveList({ json: async () => ({ items: [{ id: 'private-A' }] }) });
await pendingList;
assert.equal(serverRows, undefined, 'late A server response must not populate B gallery');
console.log('PASS stale server gallery response rejected');
let forbiddenRequests = 0;
const actionContext = { userKeyRef: { current: 'pb_B' }, tokenRef: { current: 'B', epoch: 2 }, fetch: async () => { forbiddenRequests++; }, loadMyDrawings() {} };
for (const name of ['openDrawing', 'deleteDrawing']) {
  await vm.runInNewContext(`(${callback(name)})`, actionContext)('private-A', 'pb_A');
}
assert.equal(forbiddenRequests, 0, 'stale A controls must not issue open/delete under B');
console.log('PASS stale server open/delete controls rejected');

// Full real StudioApp browser fixture; only API/PocketBase boundaries are synthetic.
if (process.env.GALLERY_BROWSER === '1') {
  const { mkdtemp, writeFile, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const { chromium } = await import('playwright');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const scratch = await mkdtemp(join(tmpdir(), 'cloud-gallery-ui-'));
  const tokens = Object.fromEntries(['A', 'B'].map(id => [id, `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`]));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
  let vite, browser, failure;
  const errors = [], checks = [], requests = [];
  const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS browser ${name}`); };
  try {
    await writeFile(join(scratch, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await writeFile(join(scratch, 'entry.jsx'), `import React from 'react';import{createRoot}from'react-dom/client';import App from ${JSON.stringify(join(root, 'src/App.jsx'))};import{getPocketBase}from ${JSON.stringify(join(root, 'src/utils/auth.js'))};window.qaAuth=async(id)=>{const pb=await getPocketBase();if(id)pb.authStore.save(${JSON.stringify(tokens)}[id],{id,name:id,email:id+'@fixture.invalid'});else pb.authStore.clear();};createRoot(document.getElementById('root')).render(<App initialJoinCode="QAGALLERY"/>);`);
    vite = await createServer({ root: scratch, envDir: scratch, configFile: false, cacheDir: join(scratch, 'vite'), publicDir: join(root, 'public'), plugins: [{ name: 'gallery-test-controls', enforce: 'pre', transform(code, id) { if (id === join(root, 'src/App.jsx')) return code.replace('  // Trace-a-photo: read a chosen photo', '  window.qaOpenGallery = () => setShowMyArt(true);\n  window.qaSheet = loadSheetImage;\n  window.qaSheetDecoded = () => !!sheetImageRef.current?.naturalWidth;\n  // Trace-a-photo: read a chosen photo'); } }, react()], resolve: { alias: { react: join(root, 'node_modules/react'), 'react-dom': join(root, 'node_modules/react-dom') } }, define: { 'import.meta.env.VITE_PB_URL': JSON.stringify('http://127.0.0.1:9252'), 'import.meta.env.VITE_WS_URL': JSON.stringify('ws://127.0.0.1:9252/ws') }, server: { host: '127.0.0.1', port: 9251, strictPort: true, fs: { allow: [root, scratch, await realpath(join(root, 'node_modules'))] } } });
    await vite.listen(); browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      const authorization = req.headers().authorization || '';
      requests.push({ path: url.pathname, authorization, method: req.method() });
      const owner = authorization.includes(tokens.A) ? 'A' : authorization.includes(tokens.B) ? 'B' : null;
      let data = {};
      if (url.pathname.includes('/snapshots/records')) {
        data = { page: 1, perPage: 500, totalItems: owner === 'A' ? 1 : 0, totalPages: 1, items: owner === 'A' ? [{ id: 'rowA', owner: 'A', client_id: 'private', title: 'PRIVATE_A_CLOUD', image: png, preview: png, client_updated: '2026-01-01T00:00:00Z' }] : [] };
      } else if (url.pathname === '/api/artworks') data = { items: owner === 'A' ? [{ id: 'private-A', name: 'PRIVATE_A_SERVER', thumb: png }] : [], max: 12 };
      else if (url.pathname === '/api/sheets/private-sheet') {
        assert.equal(owner, 'B'); data = { image: png };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.goto('http://127.0.0.1:9251');
    await page.waitForFunction(() => typeof window.qaOpenGallery === 'function');
    await page.evaluate(() => window.qaAuth('A'));
    await page.evaluate(() => window.qaOpenGallery());
    await page.getByText('PRIVATE_A_CLOUD', { exact: true }).waitFor();
    await page.getByText('PRIVATE_A_SERVER', { exact: true }).waitFor();
    check('A sees its cloud and server rows', true);
    await page.evaluate(() => window.qaAuth(null));
    await page.getByText('PRIVATE_A_CLOUD', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByText('PRIVATE_A_SERVER', { exact: true }).waitFor({ state: 'hidden' });
    check('logout removes both private listings', true);
    await page.evaluate(() => window.qaAuth('B'));
    await page.waitForTimeout(250);
    check('B cannot see or click A rows', await page.getByText(/PRIVATE_A_/).count() === 0);
    await page.evaluate(() => window.qaSheet('private-sheet'));
    await page.waitForFunction(() => window.qaSheetDecoded());
    check('private sheet JSON bearer path decodes inline raster', requests.some(req => req.path === '/api/sheets/private-sheet' && req.authorization === `Bearer ${tokens.B}`));
    check('no A artwork delete or B upload requests', !requests.some(req => req.path.includes('private-A') || req.method === 'POST' && req.authorization.includes(tokens.B)));
    check('no render errors or hook TDZ', errors.length === 0);
    await page.screenshot({ path: join(scratch, 'B-gallery.png') });
  } catch (error) { failure = error.stack; throw error; }
  finally { if (browser) await browser.close(); if (vite) await vite.close(); await writeFile(join(scratch, 'results.json'), JSON.stringify({ checks, errors, failure, syntheticApiOnly: true }, null, 2)); console.log(`Browser evidence: ${scratch}`); }
}
