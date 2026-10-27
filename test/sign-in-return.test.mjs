import test from 'node:test';
import assert from 'node:assert/strict';
import { safeSignInReturn } from '../src/utils/signInReturn.js';
test('studio signin preserves curated event and create context', () => {
  assert.equal(safeSignInReturn('/studios?event=little-joys&create=1'),'/studios?event=little-joys&create=1');
  assert.equal(safeSignInReturn('/studios'),'/studios');
  assert.equal(safeSignInReturn('/sketchbook'),'/sketchbook');
  assert.equal(safeSignInReturn('/join/MAIN'),'/join/MAIN');
});
test('return allowlist rejects external, unknown and duplicate destinations', () => {
  for (const value of ['https://evil.test','//evil.test','/studios?event=unknown','/studios?next=https://evil.test','/studios?event=little-joys&event=draw-for-rhoam','/studios#x','/studios/../admin','/studios?create=2']) assert.equal(safeSignInReturn(value),'',value);
});
