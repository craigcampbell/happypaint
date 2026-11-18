import test from 'node:test';
import assert from 'node:assert/strict';
import { getDiscoverySeo, DISCOVERY_PATHS } from '../src/data/discoverySeo.js';
import { renderDiscoveryLanding } from '../server/discoverySeo.js';

test('new discovery pages have unique canonical metadata without changing legacy URLs', () => {
  assert.deepEqual(DISCOVERY_PATHS, ['/gallery', '/studios', '/events', '/draw', '/events/draw-for-rhoam', '/events/little-joys']);
  const titles = new Set(DISCOVERY_PATHS.map((path) => getDiscoverySeo(path).title));
  assert.equal(titles.size, DISCOVERY_PATHS.length);
  assert.equal(getDiscoverySeo('/events/no-such-event'), null);
  assert.equal(getDiscoverySeo('/gallery?event=little-joys').path, '/gallery');
  assert.equal(getDiscoverySeo('/draw?event=little-joys').path, '/draw');
  assert.equal(getDiscoverySeo('/inktober').path, '/inktober');
});

test('landing HTML has real crawlable links and escapes artwork text', () => {
  const html = renderDiscoveryLanding('/gallery', [{ id: 'wp_safe', title: '<script>bad</script>', artist: 'A & B', hidden: false }]);
  assert.match(html, /href="\/wall\/wp_safe"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /href="\/events"/);
  assert.match(html, /href="\/studios"/);
  assert.match(html, /<h1>/);
});

test('sensitive landing is sourced and noncompetitive; hidden art never rendered', () => {
  const html = renderDiscoveryLanding('/events/draw-for-rhoam', [
    {id:'wp_hidden',title:'Secret title',artist:'Private name',hidden:true,event:'draw-for-rhoam'},
    {id:'wp_other',title:'Other event',artist:'A',event:'little-joys'},
  ]);
  assert.match(html, /independent community response/i);
  assert.match(html, /https:\/\/www.opb.org\//);
  assert.match(html, /\/draw\?event=draw-for-rhoam/);
  assert.doesNotMatch(html, /Secret title|Private name|Other event|leaderboard/i);
  assert.equal(renderDiscoveryLanding('/sketchbook/private', []), '');
});
