import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFriends } from '../server/friends.js';

const unblocked = () => false;

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'drawesome-friends-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createFriends(dir);
  store.profile('artist-a', 'Blue');
  store.profile('artist-b', 'Peach');
  const a = store.view('artist-a', unblocked).self;
  const b = store.view('artist-b', unblocked).self;
  return { dir, store, a, b };
}

test('both artists see the same room only after acceptance, including after a restart', t => {
  const { dir, store, a, b } = directory(t);
  let reservations = 0;
  const options = { isBlocked: unblocked, mintRoom() { reservations++; return 'FRND2345'; } };
  assert.deepEqual(store.view('guest', unblocked), { self: null, incoming: [], outgoing: [], friends: [] });
  store.contact('artist-a', b.code, 'request', options);
  assert.deepEqual(store.view('artist-b', unblocked).incoming, [a]);
  assert.deepEqual(store.view('artist-a', unblocked).friends, []);
  assert.throws(() => store.contact('artist-a', b.code, 'accept', options), /no_incoming_request/);
  store.contact('artist-b', a.code, 'accept', options);
  store.contact('artist-b', a.code, 'accept', options);
  assert.equal(reservations, 1);
  const restored = createFriends(dir);
  assert.deepEqual(restored.view('artist-a', unblocked).friends, [{ ...b, roomCode: 'FRND2345' }]);
  assert.deepEqual(restored.view('artist-b', unblocked).friends, [{ ...a, roomCode: 'FRND2345' }]);
  assert.equal(restored.memberName('FRND2345', 'artist-b'), b.name);
  assert.equal(restored.memberName('FRND2345', 'unrelated'), null);
});

test('declines suppress repeat requests and erasure cleans both sides', t => {
  const { dir, store, a, b } = directory(t);
  const options = { isBlocked: unblocked, mintRoom: () => 'FRND2345' };
  store.contact('artist-a', b.code, 'request', options);
  store.contact('artist-b', a.code, 'remove', options);
  assert.throws(() => store.contact('artist-a', b.code, 'request', options), /contact_unavailable/);
  store.contact('artist-b', a.code, 'request', options);
  store.contact('artist-a', b.code, 'accept', options);
  store.scrub('artist-b');
  const restored = createFriends(dir);
  assert.equal(restored.view('artist-b', unblocked).self, null);
  assert.deepEqual(restored.view('artist-a', unblocked).friends, []);
  assert.equal(restored.reserved('FRND2345'), false);
  assert.equal(readFileSync(join(dir, '.friends.json'), 'utf8').includes(b.code), false);
});
