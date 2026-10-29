#!/usr/bin/env node
/* global document, innerWidth, Node, localStorage, getComputedStyle */
// Discovery UI contract suite. Explicit QA fixtures, not production art or ACL evidence.
// Runs real React components in an isolated Vite harness; never loads repo .env.
import { createServer as httpServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scratchBase = process.env.TMPDIR || '/home/craig/.hermes/cache/scratch';
const scratch = await mkdtemp(join(scratchBase, 'discovery-ui-'));
const checks = [];
const diagnostics = [];
const requests = [];
let removed = false;
let browser;
const servers = [];
const tribute = { id: 'wp_qa_fixture_tribute', title: 'QA fixture: a kind creature', artist: 'QA fixture artist', event: 'draw-for-rhoam', frames: 1, tags: [], votes: 12, liked: false, allowRemix: true };
const drawing = { ...tribute, id: 'qa-fixture-ink', title: 'QA fixture: ink leaves', event: 'inktober-2026' };
const book = { id: 'qa-fixture-book', title: 'QA fixture: October pages', drawnPages: 3, artistCount: 0, unsaved: true, days: [1, 2, 3], coverRoom: 'QABOOK' };
const room = { code: 'QASTUDIO', title: 'QA fixture: studio', description: 'Explicit test fixture, not a live artist.', users: 0, ops: 5, event: 'draw-for-rhoam', canWatch: true, tags: [] };
const fixture = httpServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:9162');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  requests.push({ path: url.pathname, query: url.search, method: req.method, body });
  const send = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname.endsWith('/unpublish')) { removed = true; return send({ ok: true }); }
  if (url.pathname.includes('/frame/')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="400" height="250" fill="#ece6cf"/><text x="30" y="120" fill="#333">QA fixture artwork</text></svg>'); }
  if (url.pathname === '/api/wall/wp_qa_fixture_tribute') return send(removed ? { error: 'not_found' } : { post: tribute }, removed ? 404 : 200);
  if (url.pathname === '/api/wall') { const query = (url.searchParams.get('q') || '').toLowerCase(); const posts = [tribute, drawing].filter((post) => (!removed || post.id !== tribute.id) && (!url.searchParams.get('event') || post.event === url.searchParams.get('event')) && (!query || `${post.title} ${post.artist} ${post.tags.join(' ')}`.toLowerCase().includes(query))); return send({ posts, total: posts.length, topTags: [] }); }
  if (url.pathname === '/api/sketchbooks') return send({ books: [book], total: 1 });
  if (url.pathname === '/api/rooms/gallery') return send({ rooms: url.searchParams.get('event') === 'inktober-2026' ? [] : [room], total: url.searchParams.get('event') === 'inktober-2026' ? 0 : 1, topTags: [] });
  if (url.pathname === '/api/rooms' && req.method === 'POST') return send({ code: 'QANEW', title: 'QA fixture created studio' });
  if (url.pathname === '/api/daily') return send({ prompt: 'QA fixture daily prompt' });
  if (url.pathname === '/api/inktober') return send({ phase: 'active', year: 2026, day: 26, prompt: 'QA fixture prompt', prompts: [{ day: 1, date: '2026-10-01', prompt: 'QA fixture catch-up prompt' }] });
  return send({ error: 'qa_fixture_not_found' }, 404);
});
const component = (name) => JSON.stringify(join(repo, 'src/components', `${name}.jsx`));
await writeFile(join(scratch, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
await writeFile(join(scratch, 'entry.jsx'), `import ${JSON.stringify(join(repo, 'node_modules/@fontsource-variable/fredoka/wght.css'))};
import ${JSON.stringify(join(repo, 'node_modules/@fontsource-variable/nunito-sans/wght.css'))};
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import Home from ${component('HomePage')}; import Discovery from ${component('DiscoveryPage')}; import Event from ${component('CommunityEventPage')}; import Studios from ${component('ArtistGalleryPage')}; import Ink from ${component('InktoberPage')}; import Wall from ${component('WallPage')};
${['index.css', 'App.css', 'drawesome-theme.css', 'homepage-redesign.css', 'studio-layout.css', 'quick-stroke.css', 'route-status.css', 'site-nav.css'].map((file) => `import ${JSON.stringify(join(repo, 'src', file))};`).join('\n')}

function Harness(){const [path,setPath]=useState(location.pathname);function go(href){history.pushState({},'',href);setPath(location.pathname);} const role=new URLSearchParams(location.search).get('role'); const session=role==='owner'||role==='unverified'?{access_token:'QA_FIXTURE_NOT_A_REAL_TOKEN',verified:role==='owner'}:null;
return path==='/'?<Home onNavigate={go}/>:path==='/gallery'?<Discovery onNavigate={go}/>:path==='/events'?<Discovery initialTab="events" onNavigate={go}/>:path.startsWith('/events/')?<Event eventId={path.split('/')[2]} onNavigate={go}/>:path==='/studios'?<Studios session={session} onNavigate={go}/>:path==='/inktober'?<Ink onNavigate={go}/>:path.startsWith('/wall')?<Wall initialPostId={path.split('/')[2]||''} onNavigate={go}/>:<main><h1>QA fixture destination</h1><p>{location.pathname+location.search}</p></main>;}createRoot(document.getElementById('root')).render(<Harness/>);`);
async function startVite(port, cloud) {
  const vite = await createServer({ configFile: false, envDir: scratch, root: scratch, publicDir: join(repo, 'public'), cacheDir: join(scratch, `vite-${port}`), plugins: [react()], resolve: { alias: { 'react': join(repo, 'node_modules/react'), 'react-dom': join(repo, 'node_modules/react-dom') } }, define: { 'import.meta.env.VITE_PB_URL': JSON.stringify(cloud ? 'http://127.0.0.1:9162' : '') }, server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [repo, scratch] }, proxy: { '/api': 'http://127.0.0.1:9162' } } });
  await vite.listen(); servers.push(vite); return vite;
}
async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}\n${error.stack}`); }
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ checks, diagnostics }, null, 2));
}
try {
  await new Promise((resolveListen, reject) => { fixture.once('error', reject); fixture.listen(9162, '127.0.0.1', resolveListen); });
  await Promise.all([startVite(9161, false), startVite(9163, true)]);
  for (const port of [9161, 9163]) assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (error) => diagnostics.push(error.stack));
  let sockets = 0; page.on('websocket', (socket) => { if (new URL(socket.url()).pathname === '/ws') sockets++; });
  const goto = async (path, port = 9161) => { await page.goto(`http://127.0.0.1:${port}${path}`); await page.locator('h1').waitFor(); };
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    for (const path of ['/', '/gallery', '/events', '/events/draw-for-rhoam', '/studios', '/inktober', '/wall/wp_qa_fixture_tribute']) {
      await check(`${width}px anonymous ${path}: content and no overflow`, async () => {
        await goto(path); await page.waitForLoadState('networkidle');
        assert(await page.locator('main').innerText());
        const sizing = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, overflowing: [...document.querySelectorAll('main *')].filter((node) => node.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map((node) => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right })) }));
        assert(sizing.scrollWidth <= sizing.width, JSON.stringify(sizing));
        assert.equal(await page.locator('a[href="/draw"]').count() > 0, true);
      });
    }
  }
  await check('content-first discovery uses Drawesome fonts, compact headings and the graffiti palette', async () => {
    for (const width of [375, 1280]) for (const path of ['/', '/gallery', '/events', '/events/draw-for-rhoam', '/events/little-joys', '/studios']) {
      await page.setViewportSize({ width, height: 812 }); await goto(path);
      await page.evaluate(() => document.fonts.ready);
      const branding = await page.evaluate(() => {
        const shell = document.querySelector('.discovery-page');
        const heading = document.querySelector('.discovery-main h1');
        const action = document.querySelector('.discovery-main .primary-action');
        return {
          headings: [...document.querySelectorAll('.discovery-main h1, .discovery-main h2, .discovery-main h3, .discovery-event h3 a')].map((node) => getComputedStyle(node).fontFamily),
          displayLoaded: document.fonts.check('700 24px "Fredoka Variable"'),
          bodyLoaded: document.fonts.check('400 16px "Nunito Sans Variable"'),
          background: getComputedStyle(shell).backgroundColor,
          ink: getComputedStyle(heading).color,
          headingSize: parseFloat(getComputedStyle(heading).fontSize),
          sidebarVisible: document.querySelector('.discovery-sidebar')?.getBoundingClientRect().width > 0,
          action: getComputedStyle(action).backgroundColor,
          accent: shell.style.getPropertyValue('--discovery-accent') || getComputedStyle(shell).getPropertyValue('--discovery-accent').trim(),
        };
      });
      assert(branding.headings.every((font) => font.includes('Fredoka Variable') && !font.includes('Georgia')), JSON.stringify({ path, width, branding }));
      assert(branding.displayLoaded && branding.bodyLoaded, 'Both self-hosted brand fonts load');
      assert.equal(branding.background, 'rgb(255, 253, 244)');
      assert.equal(branding.ink, 'rgb(33, 21, 45)', `${path} ${width}px heading contrast`);
      assert.equal(branding.action, 'rgb(111, 70, 219)');
      assert(branding.headingSize <= 32, 'No oversized marketing heading');
      assert.equal(branding.sidebarVisible, width >= 1000);
    }
  });
  await check('homepage leads with real artwork then invitations; no automatic spectator sockets', async () => {
    await goto('/'); await page.getByText(drawing.title, { exact: true }).waitFor();
    assert(await page.locator('#home-art-title').evaluate((node) => node.compareDocumentPosition(document.querySelector('#home-events-title')) & Node.DOCUMENT_POSITION_FOLLOWING));
    assert.equal(await page.locator('.discovery-art-card img[loading="lazy"]').count(), 2);
    assert.equal(sockets, 0);
    await page.setViewportSize({ width: 375, height: 812 });
    assert((await page.locator('.discovery-art-card').first().boundingBox()).y < 500, 'Artwork must be visible above the fold');
    assert.equal(await page.locator('.discovery-topics a[href="/gallery?q=holiday"]').count(), 1);
    assert.equal(await page.locator('.discovery-topics a[href="/gallery?q=birthday"]').count(), 1);
    await page.getByRole('searchbox', { name: 'Search artwork' }).fill('holiday');
    await page.getByRole('button', { name: 'Search artwork', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/gallery');
    assert.equal(new URL(page.url()).searchParams.get('q'), 'holiday');
    await page.waitForLoadState('networkidle');
    assert(requests.some((request) => request.path === '/api/wall' && new URLSearchParams(request.query).get('q') === 'holiday'), 'Search reaches the real gallery transport');
  });
  await check('Artwork / Studios / Events are crawlable and active tab is explicit', async () => {
    await goto('/gallery'); assert.equal(await page.locator('nav[aria-label="Discover"] a[aria-current="page"]').innerText(), 'Artwork');
    await page.getByRole('link', { name: 'Events', exact: true }).click(); assert.equal(new URL(page.url()).pathname, '/events');
    assert.equal(await page.locator('nav[aria-label="Discover"] a[aria-current="page"]').innerText(), 'Events');
  });
  await check('public books hide internal unsaved / zero-artist copy and link to reader', async () => {
    await goto('/inktober'); await page.getByText(book.title, { exact: true }).waitFor();
    const text = await page.locator('main').innerText(); assert(!text.includes('0 artists')); assert(!text.includes('Not saved yet')); assert(!text.includes('No Inktober art yet'));
    assert(text.includes('No separate Wall posts') === false); // fixture has a separate Wall contribution
    await page.getByRole('link', { name: 'Flip through the book' }).click(); assert.equal(new URL(page.url()).pathname, `/sketchbook/${book.id}`);
  });
  await check('Inktober catch-up prompt remains selectable', async () => {
    await goto('/inktober'); await page.locator('#ink-day-filter').selectOption('1');
    await page.getByRole('button', { name: 'Draw this prompt' }).waitFor(); assert((await page.locator('main').innerText()).includes('QA fixture catch-up prompt'));
  });
  await check('sensitive tribute actions, source, contributions and watch-first studio', async () => {
    await goto('/events/draw-for-rhoam'); await page.getByText(tribute.title, { exact: true }).waitFor();
    assert.equal(await page.locator('main').getByRole('link', { name: 'Draw my own' }).getAttribute('href'), '/draw?event=draw-for-rhoam');
    assert.equal(await page.getByRole('link', { name: 'Draw with friends' }).getAttribute('href'), '/studios?event=draw-for-rhoam&create=1');
    assert.equal(await page.getByRole('link', { name: 'Watch studio', exact: false }).last().getAttribute('href'), '/live/QASTUDIO');
    assert.equal(await page.locator('a[href^="https://www.opb.org/"]').count(), 1);
    assert.equal(await page.locator('button.wall-heart, button.wall-remix-btn').count(), 0);
    assert((await page.locator('main').innerText()).includes('independent community response'));
  });
  await check('sensitive Wall spotlight and feed have no hearts, remix, competitive sorting', async () => {
    await goto('/wall/wp_qa_fixture_tribute'); await page.locator('.wall-spotlight .wall-card').waitFor();
    await page.getByRole('heading', { name: 'Manage your drawing' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Unpublish my drawing' }).count(), 1);
    assert.equal(await page.locator('.wall-spotlight .wall-heart, .wall-spotlight .wall-remix-btn, .wall-sorts').count(), 0);
    for (const card of await page.locator('.wall-card').all()) if ((await card.innerText()).includes(tribute.title)) assert.equal(await card.locator('.wall-heart, .wall-remix-btn').count(), 0);
  });
  await check('guest studio create is honest and keeps event context without accounts', async () => {
    await goto('/studios?event=draw-for-rhoam&create=1'); assert.equal(await page.locator('#ag-event').inputValue(), 'draw-for-rhoam');
    assert((await page.locator('.ag-signin-note').innerText()).includes('Accounts aren’t available'));
    assert.equal(await page.locator('.ag-signin-note a').getAttribute('href'), '/draw?event=draw-for-rhoam');
  });
  await check('configured sign-in return preserves studio event and create=1', async () => {
    await goto('/studios?event=draw-for-rhoam&create=1', 9163);
    const href = await page.locator('.ag-signin-note a').first().getAttribute('href');
    assert.equal(new URL(href, page.url()).searchParams.get('return'), '/studios?event=draw-for-rhoam&create=1');
  });
  await check('verified fixture owner auto-opens form; registry event and legacy bool submitted', async () => {
    for (const width of [375, 1280]) for (const event of ['draw-for-rhoam', 'inktober-2026']) {
      await page.setViewportSize({ width, height: 812 });
      await goto(`/studios?event=${event}&create=1&role=owner`); await page.locator('#ag-new-title').fill('QA fixture new studio');
      assert.equal(await page.locator('#ag-create-event').inputValue(), event);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole('button', { name: 'Create studio', exact: true }).click(); await page.getByText('Your studio is ready, room code QANEW.').waitFor();
      const payload = JSON.parse(requests.filter((request) => request.method === 'POST' && request.path === '/api/rooms').at(-1).body);
      assert.equal(payload.event, event); assert.equal(payload.inktober, event === 'inktober-2026'); assert.equal(payload.audience, 'artist_public');
    }
  });
  await check('unverified account cannot open studio create form', async () => {
    await goto('/studios?event=little-joys&create=1&role=unverified');
    assert.equal(await page.locator('#ag-new-title').count(), 0);
    assert((await page.locator('.ag-signin-note').innerText()).includes('isn’t verified'));
  });
  await check('receipt explicitly unpublishes with existing device identity and verifies removal', async () => {
    await goto('/events/draw-for-rhoam?post=wp_qa_fixture_tribute'); await page.evaluate(() => localStorage.setItem('drawesome:userkey:v1', 'QA_FIXTURE_DEVICE'));
    page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: 'Unpublish my drawing' }).click();
    await page.getByRole('status').filter({ hasText: 'no longer public' }).waitFor();
    const request = requests.find((item) => item.path.endsWith('/unpublish')); assert.equal(JSON.parse(request.body).userKey, 'QA_FIXTURE_DEVICE');
    assert.equal(await page.getByText(tribute.title, { exact: true }).count(), 0);
    assert(requests.some((item) => item.path === '/api/wall/wp_qa_fixture_tribute' && item.method === 'GET'));
  });
  await check('discovery errors offer retry rather than inventing empty artwork', async () => {
    await page.route('**/api/wall?**', (route) => route.fulfill({ status: 503, body: '{}' })); await goto('/gallery'); await page.getByRole('alert').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Try again', exact: true }).count(), 1); assert.equal(await page.locator('.discovery-art-card').count(), 0);
    await page.unroute('**/api/wall?**'); await page.getByRole('button', { name: 'Try again', exact: true }).click(); await page.getByText(drawing.title, { exact: true }).waitFor();
  });
  await check('mobile menu supports discovery destinations and Escape', async () => {
    await page.setViewportSize({ width: 375, height: 812 }); await goto('/'); await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('link', { name: 'Community events', exact: true }).first().waitFor({ state: 'visible' }); await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded'), 'false');
  });
  await page.setViewportSize({ width: 375, height: 812 }); await goto('/events/draw-for-rhoam'); await page.waitForLoadState('networkidle'); await page.screenshot({ path: join(scratch, 'tribute-375.png'), fullPage: true });
  await goto('/'); await page.waitForLoadState('networkidle'); await page.screenshot({ path: join(scratch, 'home-375.png'), fullPage: true });
  await check('no browser runtime errors', async () => assert.deepEqual(diagnostics, []));
} catch (error) { checks.push({ name: 'suite bootstrap', passed: false, error: error.stack }); console.error(error); }
finally {
  if (browser) await browser.close(); await Promise.all(servers.map((server) => server.close())); await new Promise((done) => fixture.close(done));
  await writeFile(join(scratch, 'results.json'), JSON.stringify({ fixtureNotice: 'Explicit isolated QA fixtures; not real artwork, backend ACL, or end-to-end canvas proof.', checks, diagnostics }, null, 2));
  console.log(`${checks.filter((check) => check.passed).length}/${checks.length} checks passed. Evidence: ${scratch}/results.json`);
  process.exitCode = checks.some((check) => !check.passed) ? 1 : 0;
}
