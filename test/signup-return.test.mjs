import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual allowlist used by SignupPage, not a duplicate regex.
const source = readFileSync(new URL('../src/components/SignupPage.jsx', import.meta.url), 'utf8');
const pattern = source.match(/return \/(.+)\/\.test\(requested\)/)?.[1];
assert.ok(pattern, 'SignupPage return allowlist located');
const accepts = (path) => new RegExp(pattern).test(path);

test('sign-in preserves sketchbook entry and exact scoped invite return', () => {
  assert.equal(accepts('/sketchbook'), true);
  assert.equal(accepts('/sketchbook/invite/sbk_Abc012_-xyz'), true);
  assert.equal(accepts('/sketchbook/sb_0123456789abcdef'), true);
});
test('existing return destinations remain valid', () => {
  for (const path of ['/family', '/rooms', '/join/ABC234']) assert.equal(accepts(path), true, path);
});
test('return allowlist rejects external URLs, traversal and injected queries', () => {
  for (const path of ['//evil.test', 'https://evil.test', '/sketchbook/../rooms', '/sketchbook/invite/', '/sketchbook/invite/abc?redirect=//evil.test', '/sketchbook/invite/abc#evil', '/sketchbook/invite/' + 'a'.repeat(97)]) assert.equal(accepts(path), false, path);
});
