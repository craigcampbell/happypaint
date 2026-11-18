import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fetchSketchbookByRoom, startGuestSketchbook, openSketchbookPrompt } from '../src/utils/sketchbookApi.js';

const require = createRequire(import.meta.url);
const { parse } = require('espree');
const root = new URL('../', import.meta.url);
async function source(path) { return readFile(new URL(path, root), 'utf8'); }
async function functionSource(path, name) {
  const text = await source(path);
  const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true }, range: true });
  let result;
  function walk(node) {
    if (!node || typeof node !== 'object' || result) return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) result = text.slice(...node.range);
    if (node.type === 'VariableDeclarator' && node.id?.name === name && node.init?.type === 'CallExpression') result = text.slice(...node.init.arguments[0].range);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else walk(value);
  }
  walk(ast);
  assert.ok(result, `${name} exists`);
  return result;
}

test('sketchbook device proof is a header, never part of the URL; bearer survives', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => { calls.push(args); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    await fetchSketchbookByRoom('ROOM /', null, 'legacy/key?secret');
    await fetchSketchbookByRoom('ROOM', { access_token: 'account-token' }, 'existing-key');
    assert.equal(calls[0][0], '/api/sketchbooks/by-room/ROOM%20%2F');
    assert.equal(calls[0][1].headers['X-Drawesome-Device-Key'], 'legacy/key?secret');
    assert.equal(calls[1][1].headers.Authorization, 'Bearer account-token');
    assert.equal(calls[1][1].headers['X-Drawesome-Device-Key'], 'existing-key');
    await startGuestSketchbook({ device: 'legacy/key?secret', day: 3 });
    assert.deepEqual(JSON.parse(calls[2][1].body), { device: 'legacy/key?secret', day: 3 });
    assert.equal(calls[2][0], '/api/sketchbooks/guest');
    await openSketchbookPrompt({ device: 'anonymous', day: 4 });
    assert.equal(JSON.parse(calls[3][1].body).device, 'anonymous');
  } finally { globalThis.fetch = original; }
});

test('gallery list/open/delete and migration keep proof out of URLs', async () => {
  for (const token of [null, 'account-token']) {
    const calls = [];
    const context = {
      userKeyRef: { current: 'legacy-capability' }, tokenRef: { current: token },
      fetch: async (...args) => { calls.push(args); return { ok: false, json: async () => ({ items: [] }) }; },
      setMyDrawings() {}, setSavesMax() {}, loadMyDrawings() {}, showToast() {},
    };
    for (const [name, args] of [['loadMyDrawings', []], ['openDrawing', ['art-id']], ['deleteDrawing', ['art-id']]]) {
      const fn = vm.runInNewContext(`(${await functionSource('src/App.jsx', name)})`, context);
      await fn(...args);
    }
    assert.equal(calls.length, 3);
    for (const [url, options] of calls) {
      assert.ok(!url.includes('?'), url);
      if (token) assert.equal(options.headers.Authorization, `Bearer ${token}`);
      if (options.method === 'DELETE') {
        assert.equal(options.headers['Content-Type'], 'application/json');
        assert.deepEqual(JSON.parse(options.body), { userKey: 'legacy-capability' });
      } else if (!token) assert.equal(options.headers['X-Drawesome-Device-Key'], 'legacy-capability');
    }
  }
  const calls = [];
  const migrate = vm.runInNewContext(`(${await functionSource('src/App.jsx', 'migrateDeviceArtToAccount')})`, {
    window: { localStorage: { getItem() {}, setItem() {} } },
    fetch: async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => calls.length === 1 ? { items: [{ id: 'saved', thumb: 'thumb' }] } : { image: 'data:image/png;base64,', name: 'art' } };
    },
  });
  await migrate('original-capability', 'account-token');
  assert.equal(calls.length, 3);
  for (const [url, options] of calls.slice(0, 2)) {
    assert.ok(!url.includes('?'));
    assert.equal(options.headers['X-Drawesome-Device-Key'], 'original-capability');
    assert.equal(options.headers.Authorization, undefined, 'migration reads device not account');
  }
  assert.equal(calls[2][1].headers.Authorization, 'Bearer account-token');
});

test('gallery save and artist owner requests retain body/bearer transport', async () => {
  for (const token of [null, 'account-token']) {
    const calls = [];
    const save = vm.runInNewContext(`(${await functionSource('src/App.jsx', 'saveToServer')})`, {
      userKeyRef: { current: 'legacy-key' }, tokenRef: { current: token }, savingArt: false,
      setSavingArt() {}, showToast() {}, composeCanvas: async () => ({}), canvasToDataUrl: async () => 'data:image/png;base64,',
      todayName: () => 'Today', loadMyDrawings: async () => {}, signalNaturalAdBreak() {},
      fetch: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ count: 1, max: 10 }) }; },
    });
    await save();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/artworks');
    assert.equal(JSON.parse(calls[0][1].body).userKey, 'legacy-key');
    assert.equal(calls[0][1].headers.Authorization, token ? `Bearer ${token}` : undefined);
  }
  const calls = [];
  const owner = vm.runInNewContext(`(${await functionSource('src/App.jsx', 'artistApiFetch')})`, {
    initialLocal: false,
    fetch: async (...args) => { calls.push(args); return { ok: true, json: async () => ({}) }; },
  });
  await owner('/api/rooms/ROOM/artist', { token: 'account-token' });
  await owner('/api/rooms/ROOM/publish', { token: 'account-token', method: 'POST', body: { description: 'art' } });
  assert.equal(calls[0][1].headers.Authorization, 'Bearer account-token');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer account-token');
  assert.deepEqual(JSON.parse(calls[1][1].body), { description: 'art' });
  assert.doesNotMatch(await source('src/App.jsx'), /[?&](?:userKey|dk)=/);
});

test('shared device identity preserves every stored capability and only mints with Web Crypto', async () => {
  const text = (await source('src/utils/deviceIdentity.js')).replace(/export /g, '');
  const load = (stored, crypto, blocked = false) => {
    const writes = [];
    const context = vm.createContext({ crypto, window: { localStorage: {
      getItem() { if (blocked) throw new Error('blocked'); return stored; },
      setItem(key, value) { writes.push([key, value]); if (blocked) throw new Error('blocked'); stored = value; },
    } } });
    vm.runInContext(text, context);
    return { get: () => vm.runInContext('getDeviceKey()', context), writes, clear: () => { stored = null; } };
  };
  for (const legacy of ['u_legacy', 'dk_legacy', 'pb_legacy', 'custom capability /?=', '  untouched  ']) {
    const identity = load(legacy, { randomUUID() { throw new Error('must not rotate'); } });
    assert.equal(identity.get(), legacy);
    assert.equal(identity.writes.length, 0);
  }
  const uuid = load(null, { randomUUID: () => '9104b00a-1465-4c4b-a84c-8d8d9376a77d' });
  assert.equal(uuid.get(), 'dk_9104b00a-1465-4c4b-a84c-8d8d9376a77d');
  assert.equal(uuid.writes[0][0], 'drawesome:userkey:v1');
  let generations = 0;
  const deleted = load(null, { randomUUID: () => `fresh-${++generations}` });
  const beforeDeletion = deleted.get();
  deleted.clear();
  assert.notEqual(deleted.get(), beforeDeletion, 'account-deletion storage wipe must not resurrect a durable capability');
  let draws = 0;
  const fallback = load(null, { getRandomValues(bytes) { draws++; assert.ok(bytes.length >= 16); bytes.fill(171); return bytes; } }, true);
  assert.match(fallback.get(), /^dk_[a-f0-9]{32,}$/);
  assert.equal(fallback.get(), fallback.get(), 'blocked storage still shares one ephemeral identity');
  assert.equal(draws, 1);
  assert.equal(load(null, {}).get(), '', 'no weak random fallback');
  for (const file of ['src/App.jsx', 'src/components/WallPage.jsx', 'src/hooks/useMultiplayer.js', 'src/utils/guestSketchbook.js']) {
    const consumer = await source(file);
    assert.match(consumer, /import .*getDeviceKey.*deviceIdentity/);
    assert.doesNotMatch(consumer, /localStorage\.(?:getItem|setItem)\("drawesome:userkey:v1"/);
  }
});

test('public Wall requests do not transmit device capabilities', async () => {
  const text = await source('src/components/WallPage.jsx');
  assert.doesNotMatch(text, /params\.set\("userKey"|\?userKey=/);
});
