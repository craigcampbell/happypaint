// Real isolated HTTP/WS integration checks. Only ports 9151/9152; no build or live data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { COMMUNITY_EVENTS } from '../src/data/communityEvents.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync('/home/craig/.hermes/cache/scratch/community-events-');
// Copy only the server entry and real source shell to a scratch runtime.
// Imports point at the worktree; no build/stub writes ever touch that tree.
const runtime = join(scratch, 'runtime');
mkdirSync(join(runtime, 'dist'), { recursive: true });
copyFileSync(join(root, 'server.js'), join(runtime, 'server.js'));
copyFileSync(join(root, 'index.html'), join(runtime, 'dist/index.html'));
writeFileSync(join(runtime, 'package.json'), '{"type":"module"}');
for (const name of ['server', 'src', 'node_modules', 'public']) symlinkSync(join(root, name), join(runtime, name));
const clock = join(scratch, 'clock');
writeFileSync(clock, '2026-10-05T12:00:00.000Z');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc;
let log = '';
const mock = http.createServer((req, res) => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const id = { owner_token: 'communityowner', other_token: 'communityother', outsider_token: 'communityoutside' }[token];
  if (req.method === 'POST' && req.url === '/api/collections/users/auth-refresh' && id) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ record: { id, name: 'Test artist' } }));
  } else res.writeHead(401).end('{}');
});
async function stop() {
  if (!proc || proc.exitCode !== null) return;
  const done = once(proc, 'exit');
  proc.kill('SIGTERM');
  await done;
}
async function boot(cloud = false) {
  proc = spawn(process.execPath, ['server.js'], { cwd: runtime, stdio: 'pipe', env: {
    ...process.env, PORT: '9151', DATA_DIR: join(scratch, 'data'), WALL_DIR: join(scratch, 'data/.wall'),
    PB_URL: cloud ? 'http://127.0.0.1:9152' : '', INKTOBER_CLOCK_FILE: clock,
  } });
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) throw new Error(`Server exited: ${log}`);
    try { if ((await fetch('http://127.0.0.1:9151/healthz')).ok) return; } catch { /* starting */ }
    await sleep(100);
  }
  throw new Error(`Server did not start: ${log}`);
}
const clients = [];
async function connect(code, token) {
  const ws = new WebSocket(`ws://127.0.0.1:9151/ws?room=${code}`);
  const client = { ws, messages: [] };
  clients.push(client);
  ws.on('message', (raw) => { client.messages.push(JSON.parse(raw)); });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token, userKey: 'ws-test-device' }));
  for (let i = 0; i < 50; i++) {
    if (client.messages.some((m) => m.type === 'connected')) return client;
    await sleep(60);
  }
  throw new Error(`WS join failed: ${JSON.stringify(client.messages)}`);
}
async function api(path, body, token) {
  const r = await fetch(`http://127.0.0.1:9151${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, data: await r.json() };
}
try {
  await boot();
  const registry = await api('/api/community-events');
  assert.equal(registry.status, 200);
  assert.deepEqual(registry.data.events, COMMUNITY_EVENTS);
  assert.equal((await api('/api/rooms', { audience: 'artist_public', title: 'No cloud studio', event: 'little-joys' })).data.error, 'accounts_required');
  console.log('PASS curated registry available anonymously without cloud');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
  const post = (userKey, event, extra = {}) => api('/api/wall', { userKey, event, room: null, title: 'Kind drawing', frames: [png], ...extra });
  assert.equal((await post('bad-event', 'not-a-real-event')).status, 400);
  assert.equal((await post('bad-event-type', { id: 'little-joys' })).status, 400);
  const ordinary = await post('ordinary-null', null, { allowRemix: true });
  assert.equal(ordinary.status, 200, 'null means no explicit event for existing clients');
  assert.equal((await api(`/api/wall/${ordinary.data.id}`)).data.post.event, null);
  const posted = await post('local-owner', 'draw-for-rhoam', { allowRemix: true });
  assert.equal(posted.status, 200);
  const id = posted.data.id;
  const tribute = (await api(`/api/wall/${id}`)).data.post;
  assert.equal(tribute.event, 'draw-for-rhoam');
  assert.equal(tribute.eventDay, null);
  assert.equal(tribute.allowRemix, false);
  assert.equal(tribute.sensitive, true);
  assert.equal(tribute.allowVote, false);
  assert.equal((await api(`/api/wall/${id}/vote`, {})).status, 403);
  assert.equal((await api(`/api/wall/${id}/remix-room`, {})).status, 404);
  assert.equal((await post('fake-remix', 'little-joys', { parentPostId: id })).status, 400);
  assert.equal((await api('/api/wall?sort=top')).data.posts.some((p) => p.id === id), false);
  assert.equal((await api('/api/wall?event=draw-for-rhoam')).data.posts[0].id, id);
  const frame = await fetch(`http://127.0.0.1:9151/api/wall/${id}/frame/0`);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await frame.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
  const stored = JSON.parse(readFileSync(join(scratch, 'data/.wall', `${id}.frames.json`), 'utf8'));
  assert.deepEqual(stored, [png]);
  console.log('PASS explicit contribution, unknown ids, immutable raster snapshot, sensitive protections');
  assert.equal((await api(`/api/wall/${id}/unpublish`, { userKey: 'someone-else' })).status, 403);
  assert.equal((await api(`/api/wall/${id}/unpublish`, { userKey: 'pb_communityowner' })).status, 401);
  assert.equal((await api(`/api/wall/${id}/unpublish`, { userKey: 'local-owner' })).status, 200);
  assert.equal((await api(`/api/wall/${id}`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:9151/api/wall/${id}/frame/0`)).status, 404);
  assert.equal((await api('/api/wall?event=draw-for-rhoam')).data.total, 0);
  assert.equal((await api(`/api/wall/${id}/unpublish`, { userKey: 'local-owner' })).status, 200);
  await stop();
  await boot();
  assert.equal((await api(`/api/wall/${id}`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:9151/api/wall/${id}/frame/0`)).status, 404);
  assert.equal((await api('/api/wall?event=draw-for-rhoam')).data.total, 0);
  console.log('PASS owner-only idempotent retraction hides feed/detail/frame immediately and after restart');
  await stop();
  await new Promise((r) => mock.listen(9152, '127.0.0.1', r));
  await boot(true);
  assert.equal((await api('/api/rooms', { audience: 'artist_public', title: 'Invalid', event: 'unknown' }, 'owner_token')).status, 400);
  const made = await api('/api/rooms', { audience: 'artist_public', title: 'Kind studio', event: 'draw-for-rhoam' }, 'owner_token');
  assert.equal(made.status, 200);
  const code = made.data.code;
  assert.equal((await api(`/api/rooms/${code}/artist`, undefined, 'owner_token')).data.event, 'draw-for-rhoam');
  assert.equal((await api('/api/rooms/gallery?event=draw-for-rhoam')).data.total, 0);
  assert.equal((await api(`/api/rooms/${code}/publish`, { event: 'little-joys' }, 'other_token')).status, 403);
  assert.equal((await api(`/api/rooms/${code}/publish`, { event: 'unknown' }, 'owner_token')).status, 400);
  const published = await api(`/api/rooms/${code}/publish`, {}, 'owner_token');
  assert.equal(published.data.event, 'draw-for-rhoam');
  assert.equal((await api('/api/rooms/gallery?event=draw-for-rhoam')).data.rooms[0].code, code);
  await sleep(2800); // room metadata write-behind
  await stop();
  await boot(true);
  assert.equal((await api('/api/rooms/gallery?event=draw-for-rhoam')).data.rooms[0].code, code);
  assert.equal((await api(`/api/rooms/${code}/artist`, undefined, 'owner_token')).data.event, 'draw-for-rhoam');
  await api(`/api/rooms/${code}/unpublish`, {}, 'owner_token');
  assert.equal((await api('/api/rooms/gallery?event=draw-for-rhoam')).data.total, 0, 'live unpublish must override cached dormant listing');
  await api(`/api/rooms/${code}/publish`, {}, 'owner_token');
  assert.equal((await api(`/api/rooms/${code}/publish`, { inktober: true }, 'owner_token')).data.event, 'inktober-2026');
  assert.equal((await api('/api/rooms/gallery?event=inktober-2026')).data.rooms[0].code, code);
  assert.equal((await api(`/api/rooms/${code}/publish`, { event: 'little-joys' }, 'owner_token')).data.inktober, false);
  assert.equal((await api('/api/rooms/gallery?event=little-joys')).data.rooms[0].code, code);
  assert.equal((await api(`/api/rooms/${code}/unpublish`, {}, 'other_token')).status, 403);
  assert.equal((await api(`/api/rooms/${code}/unpublish`, {}, 'owner_token')).status, 200);
  assert.equal((await api('/api/rooms/gallery?event=little-joys')).data.total, 0);
  assert.equal((await api('/api/rooms/gallery')).data.rooms.some((room) => room.code === code), false);
  console.log('PASS studio opt-in remains unpublished until consent, owner-only mutation, filter/restart, legacy Inktober compatibility');
  const owner = await connect(code, 'owner_token');
  const viewer = await connect(code, 'other_token');
  assert.equal(viewer.messages.find((m) => m.type === 'connected').canPaint, false);
  const studioPost = await api('/api/wall', { room: code, frames: [png] }, 'owner_token');
  assert.equal((await api(`/api/wall/${studioPost.data.id}`)).data.post.event, 'little-joys');
  const strangerPost = await api('/api/wall', { room: code, frames: [png] }, 'other_token');
  assert.equal((await api(`/api/wall/${strangerPost.data.id}`)).data.post.event, null);
  const explicit = await api('/api/wall', { room: code, event: 'draw-for-rhoam', frames: [png] }, 'other_token');
  assert.equal((await api(`/api/wall/${explicit.data.id}`)).data.post.event, 'draw-for-rhoam');
  const draw = (strokeId) => ({ type: 'op', op: { kind: 'draw', strokeId, points: [{ x: 5, y: 5 }, { x: 15, y: 15 }], settings: { brush: 'pencil', size: 5, color: '#000000', opacity: 1 }, end: true } });
  viewer.ws.send(JSON.stringify(draw('viewer-denied')));
  await sleep(250);
  assert.equal(owner.messages.some((m) => m.type === 'op' && m.op.strokeId === 'viewer-denied'), false);
  owner.ws.send(JSON.stringify(draw('owner-allowed')));
  await sleep(250);
  assert.equal(viewer.messages.some((m) => m.type === 'op' && m.op.strokeId === 'owner-allowed'), true);
  const viewerId = viewer.messages.find((m) => m.type === 'connected').userId;
  owner.ws.send(JSON.stringify({ type: 'paint_approve', targetId: viewerId }));
  await sleep(250);
  assert.equal(viewer.messages.some((m) => m.type === 'role_changed' && m.canPaint === true), true);
  viewer.ws.send(JSON.stringify(draw('painter-allowed')));
  await sleep(250);
  assert.equal(owner.messages.some((m) => m.type === 'op' && m.op.strokeId === 'painter-allowed'), true);
  const pinned = await fetch(`http://127.0.0.1:9151/api/wall/${studioPost.data.id}/frame/0`);
  assert.deepEqual(Buffer.from(await pinned.arrayBuffer()), Buffer.from(png.split(',')[1], 'base64'));
  assert.equal((await api('/api/wall', { frames: [png], userKey: 'pb_forged' })).status, 401);
  assert.equal((await api('/api/wall', { frames: [png], userKey: 'fallback-device' }, 'invalid_token')).status, 401);
  viewer.ws.send(JSON.stringify({ type: 'set_wet', wet: true }));
  await sleep(200);
  assert.equal(owner.messages.some((m) => m.type === 'wet_state' && m.wet === true), false, 'approved painter cannot manage room');
  const painterPost = await api('/api/wall', { room: code, frames: [png] }, 'other_token');
  assert.equal((await api(`/api/wall/${painterPost.data.id}`)).data.post.event, 'little-joys');
  assert.equal((await api(`/api/wall/${studioPost.data.id}/unpublish`, { userKey: 'pb_communityowner' }, 'other_token')).status, 403);
  assert.equal((await api(`/api/wall/${studioPost.data.id}/unpublish`, { userKey: 'pretend' }, 'owner_token')).status, 200);
  assert.equal((await api(`/api/wall/${studioPost.data.id}`)).status, 404);
  for (const c of clients) c.ws.close();
  await api(`/api/rooms/${code}/publish`, { inktober: true }, 'owner_token');
  const ink = await api('/api/wall', { room: code, frames: [png], eventDay: 99, eventPrompt: 'forged' }, 'owner_token');
  const inkPost = (await api(`/api/wall/${ink.data.id}`)).data.post;
  assert.equal(inkPost.event, 'inktober-2026');
  assert.equal(inkPost.eventDay, 5);
  assert.notEqual(inkPost.eventPrompt, 'forged');
  console.log('PASS live studio owner/painter-only automatic association, explicit invitation not origin, account retraction, WS ACLs');
  await stop();
  await boot(true);
  const offline = await api('/api/wall', { room: code, frames: [png] }, 'owner_token');
  assert.equal((await api(`/api/wall/${offline.data.id}`)).data.post.event, 'inktober-2026');
  const offlineStranger = await api('/api/wall', { room: code, frames: [png] }, 'outsider_token');
  assert.equal((await api(`/api/wall/${offlineStranger.data.id}`)).data.post.event, null);
  const shared = await post('shared-ink', undefined, { room: 'INKTOBER' });
  assert.equal((await api(`/api/wall/${shared.data.id}`)).data.post.event, 'inktober-2026');
  const book = await api('/api/sketchbooks', { event: 'inktober-2026', title: 'Private art' }, 'owner_token');
  assert.equal(book.data.book.public, false);
  const bookId = book.data.book.id;
  const page = await api(`/api/sketchbooks/${bookId}/pages`, { day: 5 }, 'owner_token');
  const privatePost = await post('private-book-probe', 'draw-for-rhoam', { room: page.data.page.room });
  assert.equal(privatePost.status, 403);
  assert.equal(privatePost.data.error, 'book_private');
  assert.equal((await api(`/api/rooms/${page.data.page.room}/publish`, { event: 'draw-for-rhoam' }, 'owner_token')).data.error, 'book_managed');
  assert.equal((await api('/api/rooms/gallery?event=draw-for-rhoam')).data.total, 0);
  console.log('PASS offline Inktober attribution ACL, shared automatic stamp, explicit event cannot expose private sketchbook');
  const sitemap = await (await fetch('http://127.0.0.1:9151/sitemap.xml')).text();
  const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, new Set(locs).size);
  for (const path of ['/wall', '/rooms', '/studio', '/inktober', '/gallery', '/parents', '/privacy', '/studios', '/events', '/events/draw-for-rhoam', '/events/little-joys']) {
    assert.equal(locs.some((loc) => loc.endsWith(path)), true, `sitemap contains ${path}`);
  }
  assert.equal(locs.some((loc) => loc.endsWith(`/wall/${id}`)), false);
  const eventHtml = await (await fetch('http://127.0.0.1:9151/events/draw-for-rhoam')).text();
  assert.match(eventHtml, /<h1>Draw for Rhoam<\/h1>/);
  assert.match(eventHtml, /data-discovery-landing/);
  assert.match(eventHtml, /<link(?=[^>]*data-seo="canonical")(?=[^>]*href="https:\/\/drawesome.art\/events\/draw-for-rhoam")[^>]*>/);
  assert.equal(eventHtml.includes(`/wall/${id}`), false);
  assert.equal(eventHtml.includes(page.data.page.room), false);
  for (const path of ['/events/not-real', '/sketchbook/invite/private-code', '/admin', '/watch/PRIVATE']) {
    const r = await fetch(`http://127.0.0.1:9151${path}`);
    if (path.startsWith('/events/')) assert.equal(r.status, 404);
    assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
  }
  assert.equal((await fetch('http://127.0.0.1:9151/api/not-real')).status, 404);
  console.log('PASS additive unique sitemap, real initial public landing HTML, retraction/private exclusions, noindex and unknown-event 404');
} finally {
  for (const c of clients) c.ws.terminate();
  await stop();
  if (mock.listening) await new Promise((r) => mock.close(r));
}
