import test from 'node:test';
import assert from 'node:assert/strict';
import { CURATOR_PAGES, validateCuratorContent, getCuratorDefaults } from '../src/data/curatorContent.js';

test('curator edits are bounded structured content for existing discovery routes', () => {
  assert.deepEqual(Object.keys(CURATOR_PAGES), ['home', 'gallery', 'events', 'studios']);
  const content = getCuratorDefaults('home');
  assert.equal(validateCuratorContent('home', content).ok, true);
  assert.equal(validateCuratorContent('unknown', content).ok, false);
  assert.equal(validateCuratorContent('home', {...content, title: 'x'.repeat(121)}).ok, false);
  assert.equal(validateCuratorContent('home', {...content, ctaHref: 'javascript:alert(1)'}).ok, false);
  assert.equal(validateCuratorContent('home', {...content, html: '<script>x</script>'}).ok, false);
  assert.equal(validateCuratorContent('home', {...content, palette: 'anything'}).ok, false);
});
