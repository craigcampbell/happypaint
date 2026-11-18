import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { createFeaturedRooms } from '../server/featuredRooms.js';

const root = '/home/craig/.hermes/cache/scratch';
const publicRoom = () => ({ exists: true, audience: 'kid_safe', listed: true, hidden: false, sketchbook: false, version: 'room-incarnation-1:moderation-0' });
const payload = (image, extra = {}) => ({ roomCode: 'MAIN', title: '', image, confirmed: true, version: publicRoom().version, ...extra });

test('writes and management require admin authentication; public reads do not', async (t) => {
  const f = await fixture(t);
  for (const [path, method, body] of [['/api/admin/featured-rooms', 'GET'], ['/api/admin/featured-rooms/source/MAIN', 'GET'], ['/api/admin/featured-rooms', 'POST', payload(f.image)], ['/api/admin/featured-rooms/anything', 'DELETE']]) {
    assert.equal((await f.request(path, { auth: false, method, body })).status, 401);
  }
  assert.equal((await f.request('/api/featured-rooms', { auth: false })).status, 200);
});

test('rejects private/friends/unpublished/unlisted/hidden/missing and every sketchbook', async (t) => {
  const f = await fixture(t);
  for (const change of [{ audience: 'friends' }, { audience: 'private' }, { audience: 'artist_public', published: false }, { listed: false }, { hidden: true }, { exists: false }, { sketchbook: {} }, { sketchbook: true }, { sketchbook: undefined }]) {
    f.setSource({ ...publicRoom(), ...change });
    assert.equal((await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image) })).status, 403, JSON.stringify(change));
    assert.equal((await f.request('/api/admin/featured-rooms/source/MAIN')).status, 403);
  }
  f.setSource(null);
  assert.equal((await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image) })).status, 403);
});

test('withdraws listing AND image reads after source privacy/hide/delete/version changes, including restart', async (t) => {
  const f = await fixture(t);
  const { item } = await (await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image) })).json();
  for (const source of [{ ...publicRoom(), listed: false }, { ...publicRoom(), hidden: true }, { ...publicRoom(), audience: 'friends' }, { ...publicRoom(), sketchbook: true }, { ...publicRoom(), version: 'new-incarnation-or-moderation' }, null]) {
    f.setSource(source);
    assert.deepEqual((await (await f.request('/api/featured-rooms')).json()).items, []);
    const image = await f.request(item.imageUrl);
    assert.equal(image.status, 404);
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.equal((await (await f.request('/api/admin/featured-rooms')).json()).items[0].available, false);
  }
  await f.restart();
  assert.equal((await f.request(item.imageUrl)).status, 404);
  assert.equal((await f.request(`/api/admin/featured-rooms/${item.id}`, { method: 'DELETE' })).status, 200);
});

test('rejects URLs/SVG/spoofed raster bytes, malformed identifiers, unconfirmed publication, overlong titles and stale preview', async (t) => {
  const f = await fixture(t);
  for (const invalid of [{ image: 'https://example.com/image.png' }, { image: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}` }, { image: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}` }, { image: f.image.replace('image/png', 'image/jpeg') }, { roomCode: '../MAIN' }, { roomCode: 123 }, { roomCode: 'main' }, { title: 'x'.repeat(81) }, { title: 'bad\ntext' }, { confirmed: false }, { url: 'https://example.com' }]) {
    assert.equal((await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image, invalid) })).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image, { version: 'stale' }) })).status, 409);
});

test('rechecks authoritative eligibility after async image normalization', async (t) => {
  let calls = 0;
  const f = await fixture(t, { getRoomEligibility: () => (++calls === 1 ? publicRoom() : null) });
  assert.equal((await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image) })).status, 409);
  assert.deepEqual((await (await f.request('/api/featured-rooms')).json()).items, []);
});

test('bounds collection count, input bytes, normalized bytes and total bytes', async (t) => {
  const f = await fixture(t, { limits: { items: 1 } });
  assert.equal((await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image) })).status, 201);
  assert.equal((await f.request('/api/admin/featured-rooms', { method: 'POST', body: payload(f.image) })).status, 409);
  const smallInput = await fixture(t, { limits: { inputBytes: 10 } });
  assert.equal((await smallInput.request('/api/admin/featured-rooms', { method: 'POST', body: payload(smallInput.image) })).status, 413);
  const smallOutput = await fixture(t, { limits: { imageBytes: 10 } });
  assert.equal((await smallOutput.request('/api/admin/featured-rooms', { method: 'POST', body: payload(smallOutput.image) })).status, 413);
  const smallTotal = await fixture(t, { limits: { totalBytes: 10 } });
  assert.equal((await smallTotal.request('/api/admin/featured-rooms', { method: 'POST', body: payload(smallTotal.image) })).status, 409);
});
async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(`${root}/featured-test-`);
  let source = publicRoom();
  const getRoomEligibility = () => source;
  let server;
  const start = async () => {
    const feature = createFeaturedRooms({ dataDir, getRoomEligibility, ...options });
    const app = express();
    feature.registerRoutes(app, (req, res) => req.get('x-admin-key') === 'test-admin' || (res.status(401).json({ error: 'unauthorized' }), false));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start();
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', body, auth = true } = {}) => fetch(base + path, { method, headers: { ...(auth ? { 'x-admin-key': 'test-admin' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const image = `data:image/png;base64,${(await sharp({ create: { width: 60, height: 40, channels: 3, background: '#e7472d' } }).png().toBuffer()).toString('base64')}`;
  return { request, image, setSource: (value) => { source = value; }, restart: async () => { await new Promise((resolve) => server.close(resolve)); base = await start(); } };
}

test('requires a preview source version before publishing', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/api/admin/featured-rooms', { method: 'POST', body: { roomCode: 'MAIN', title: '', image: f.image, confirmed: true } });
  assert.equal(response.status, 400);
});

test('admin publishes a frozen normalized picture, persisted across restart, removable', async (t) => {
  const f = await fixture(t);
  const saved = await f.request('/api/admin/featured-rooms', { method: 'POST', body: { roomCode: 'MAIN', title: 'Together', image: f.image, confirmed: true, version: publicRoom().version } });
  assert.equal(saved.status, 201);
  const { item } = await saved.json();
  assert.equal(item.roomCode, 'MAIN');
  assert.equal(item.title, 'Together');
  assert.ok(item.capturedAt);
  await f.restart();
  const listing = await f.request('/api/featured-rooms', { auth: false });
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  assert.equal((await listing.json()).items[0].id, item.id);
  const image = await f.request(item.imageUrl, { auth: false });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal((await sharp(Buffer.from(await image.arrayBuffer())).metadata()).format, 'webp');
  assert.equal((await f.request(`/api/admin/featured-rooms/${item.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await f.request('/api/featured-rooms')).json()).items.length, 0);
  assert.equal((await f.request(item.imageUrl)).status, 404);
});
