import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFeaturedRooms } from '../server/featuredRooms.js';

test('source-scoped account erasure removes durable pixels/provenance and preserves unrelated selections', async (t) => {
  const dataDir = await mkdtemp('/home/craig/.hermes/cache/scratch/featured-erasure-');
  const source = (code) => ({ exists: true, audience: 'kid_safe', listed: true, hidden: false, sketchbook: false, version: code + ':epoch', profileIds: [code === 'LONG_CODE-123456' ? 'deleted-profile' : 'other-profile'] });
  const feature = createFeaturedRooms({ dataDir, getRoomEligibility: source });
  const app = express(); feature.registerRoutes(app, () => true);
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  t.after(async () => { await new Promise((r) => server.close(r)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const image = 'data:image/png;base64,' + (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64');
  const publish = async (roomCode) => {
    const response = await fetch(base + '/api/admin/featured-rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode, title: '', image, confirmed: true, version: source(roomCode).version }) });
    assert.equal(response.status, 201); return (await response.json()).item;
  };
  const selected = await publish('LONG_CODE-123456'), unrelated = await publish('OTHER');
  const publicList = await (await fetch(base + '/api/featured-rooms')).text();
  const adminList = await (await fetch(base + '/api/admin/featured-rooms')).text();
  for (const response of [publicList, adminList]) { assert.ok(!response.includes('deleted-profile')); assert.ok(!response.includes('sourceProfiles')); }
  assert.equal(feature.scrubProfile('deleted-profile'), 1);
  assert.equal((await fetch(base + selected.imageUrl)).status, 404);
  assert.equal((await fetch(base + unrelated.imageUrl)).status, 200);
  await assert.rejects(access(join(dataDir, '.featured-rooms', selected.id + '.webp')));
  const stored = JSON.parse(await readFile(join(dataDir, '.featured-rooms/index.json'), 'utf8'));
  assert.deepEqual(stored.items.map((item) => item.id), [unrelated.id]);
  assert.ok(!JSON.stringify(stored).includes('deleted-profile'));
  const restarted = createFeaturedRooms({ dataDir, getRoomEligibility: source });
  assert.equal(restarted.scrubProfile('deleted-profile'), 0);
  assert.equal(restarted.scrubSources((code) => code === 'OTHER'), 1);
  await assert.rejects(access(join(dataDir, '.featured-rooms', unrelated.id + '.webp')));
});

test('legacy selections without capture-time attribution are erased conservatively', async (t) => {
  const dataDir = await mkdtemp('/home/craig/.hermes/cache/scratch/featured-legacy-erasure-');
  const source = () => ({ exists: true, audience: 'kid_safe', listed: true, hidden: false, sketchbook: false, version: 'legacy' });
  const feature = createFeaturedRooms({ dataDir, getRoomEligibility: source });
  const app = express(); feature.registerRoutes(app, () => true);
  const server = app.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
  t.after(async () => { await new Promise((r) => server.close(r)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const image = 'data:image/png;base64,' + (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64');
  const response = await fetch(base + '/api/admin/featured-rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode: 'MAIN', title: '', image, confirmed: true, version: 'legacy' }) });
  assert.equal(response.status, 201);
  const { item } = await response.json();
  assert.equal(feature.scrubProfile('any-deleted-account'), 1);
  await assert.rejects(access(join(dataDir, '.featured-rooms', item.id + '.webp')));
});
