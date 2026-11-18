import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGallery, roomProfileFor } from '../server/artistRooms.js';

test('persisted gallery associations accept curated ids only', () => {
  assert.equal(normalizeGallery({ event: 'draw-for-rhoam' }).event, 'draw-for-rhoam');
  assert.equal(normalizeGallery({ event: 'made-up' }).event, null);
  assert.equal(normalizeGallery({ event: { id: 'little-joys' } }).event, null);
});

test('public studio profile exposes association, never owner identity or publication consent', () => {
  const room = { audience: 'artist_public', ownerProfileId: 'secret-account', gallery: { event: 'draw-for-rhoam', listed: false } };
  const profile = roomProfileFor(room);
  assert.equal(profile.event.id, 'draw-for-rhoam');
  assert.equal(JSON.stringify(profile).includes('secret-account'), false);
  assert.equal(Object.hasOwn(profile, 'listed'), false);
});

test('legacy Inktober profiles retain derived seasonal state', () => {
  const state = { id: 'inktober-2026', day: 5, prompt: 'Test prompt' };
  assert.deepEqual(roomProfileFor({ audience: 'artist_public', inktober: true }, state).event, state);
});
