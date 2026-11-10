import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('function featuredSource(code) {');
const end = source.indexOf('\nfunction persistRoom(', start);
assert.ok(start >= 0 && end > start);

for (const dormant of [false, true]) {
  test(`featured source respects authoritative book reservation with missing back-reference (${dormant ? 'dormant' : 'live'} room)`, () => {
    const room = { audience: 'kid_safe', listed: true, featuredVersion: 'current-version' };
    let reserved = false;
    const context = vm.createContext({
      RETIRED_ROOM_CODES: new Set(),
      rooms: new Map(dormant ? [] : [['PUBLIC', room]]),
      readFileSync: () => JSON.stringify(room), roomFile: (code) => code,
      normalizeGallery: () => ({ moderationHidden: false }),
      ARTIST_AUDIENCE: 'artist_public',
      storedSketchbookRef: () => reserved ? { book: 'private-book' } : null,
      analytics: { users: {} },
    });
    vm.runInContext(source.slice(start, end) + '\nglobalThis.getSource = featuredSource;', context);
    assert.equal(context.getSource('PUBLIC').sketchbook, false);
    reserved = true;
    const result = context.getSource('PUBLIC');
    assert.equal(result.sketchbook, true, 'reservation blocks featured publication even without room back-reference');
    assert.equal(result.version, 'current-version', 'completed version adapter remains intact');
    assert.equal(result.listed, true);
  });
}
