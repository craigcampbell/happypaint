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

test('private drawing sign-in preserves a selected idea or bounded legacy text', () => {
  for (const id of ['ink-cat', 'record-monster', 'sky-fish', 'idea-1', 'idea-8']) {
    const url = '/draw?idea=' + id;
    assert.equal(safeSignInReturn(url), url);
  }
  const prompt = 'Bird & cloud? Draw #2 + 🐟';
  assert.equal(safeSignInReturn('/draw?' + new URLSearchParams({ prompt })), '/draw?prompt=' + encodeURIComponent(prompt));
  assert.equal(safeSignInReturn('/draw?prompt=' + 'A'.repeat(180)), '/draw?prompt=' + 'A'.repeat(180));
});

test('private drawing returns reject unknown ids, extra fields, controls and overlong text', () => {
  for (const value of ['/draw?idea=nope', '/draw?idea=idea-9', '/draw?idea=ink-cat#x',
    '/draw?idea=ink-cat&idea=idea-1', '/draw?idea=ink-cat&prompt=wrong', '/draw?prompt=%0A',
    '/draw?prompt=%20', '/draw?prompt=a&next=https://example.test', '/draw?prompt=' + 'a'.repeat(181)]) {
    assert.equal(safeSignInReturn(value), '', value);
  }
});
