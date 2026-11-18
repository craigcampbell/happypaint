import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

// Execute the actual sync source; only the PocketBase/auth and IDB boundaries
// are synthetic. No live endpoint, browser profile, or user storage is touched.
async function fixture({ items = [], rows = [], configured = true } = {}) {
  let stored = structuredClone(items);
  const requests = [];
  const hooks = {};
  const authStore = { isValid: true, record: { id: 'A' }, token: 'token-A' };
  const pb = { authStore, collection: () => ({
    async getFullList(options) {
      requests.push({ op: 'list', options, auth: authStore.token });
      if (hooks.list) await hooks.list();
      return structuredClone(rows.filter(row => options.filter.includes(`"${row.owner}"`)));
    },
    async getFirstListItem(filter, options) {
      requests.push({ op: 'find', filter, options, auth: authStore.token });
      if (hooks.find) await hooks.find();
      throw Object.assign(new Error('not found'), { status: 404 });
    },
    async create(data, options) { requests.push({ op: 'create', data, options, auth: authStore.token }); },
    async update(id, data, options) { requests.push({ op: 'update', id, data, options, auth: authStore.token }); },
  }) };
  const context = vm.createContext({ console, setTimeout, clearTimeout, AbortController,
    window: { localStorage: { getItem: () => JSON.stringify(stored), setItem: (_key, value) => { stored = JSON.parse(value); } } },
  });
  const auth = new vm.SyntheticModule(['getPocketBase', 'getProfileId', 'isCloudConfigured'], function () {
    this.setExport('isCloudConfigured', configured);
    this.setExport('getPocketBase', async () => configured ? pb : null);
    this.setExport('getProfileId', async () => authStore.record?.id);
  }, { context });
  const idb = new vm.SyntheticModule(['idbGetKV', 'idbSetKV', 'isIdbAvailable'], function () {
    this.setExport('idbGetKV', async () => { if (hooks.read) await hooks.read(); return structuredClone(stored); });
    this.setExport('idbSetKV', async (_key, value) => { if (hooks.write) await hooks.write(); stored = structuredClone(value); });
    this.setExport('isIdbAvailable', () => true);
  }, { context });
  const source = await readFile(new URL('../src/utils/sync.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(specifier => specifier === './auth' ? auth : idb);
  await module.evaluate();
  const sync = module.namespace;
  const visible = () => sync.getVisibleGallery ? sync.getVisibleGallery(stored) : stored;
  const login = async id => {
    authStore.record = { id }; authStore.token = `token-${id}`;
    await sync.startSync({ user: { id }, access_token: `token-${id}` });
  };
  return { sync, visible, login, requests, hooks, authStore, stored: () => stored };
}
const remote = (owner, id = 'private') => ({ owner, client_id: id, title: `${owner} private`, image: owner, client_updated: '2026-10-01T00:00:00Z' });

test('A logout B never displays or uploads A private cloud records', async () => {
  const f = await fixture({ rows: [remote('A'), remote('B')] });
  await f.login('A');
  assert.equal(f.visible()[0]?.name, 'A private');
  f.sync.stopSync();
  assert.equal(f.visible().length, 0, 'logout must hide A immediately, without deleting art');
  assert.equal(f.stored().length, 1, 'private art must remain durably recoverable');
  await f.login('B');
  assert.deepEqual(Array.from(f.visible(), x => x.name), ['B private']);
  assert.equal(f.requests.some(r => r.op === 'create' && r.data.owner === 'B' && r.data.image === 'A'), false);
  await f.login('A');
  assert.deepEqual(Array.from(f.visible(), x => x.name), ['A private']);
  f.sync.stopSync();
});

test('colliding cloud IDs do not overwrite anonymous art or browser-only consent', async () => {
  const f = await fixture({ items: [{ id: 'private', name: 'Device only', layer: 'local', localOnly: true }], rows: [remote('A')] });
  await f.login('A');
  assert.equal(f.visible().length, 2);
  assert.equal(new Set(f.visible().map(x => x.id)).size, 2, 'visible cloud ids must not collide with device ids');
  assert.equal(f.visible().find(x => x.layer === 'local').localOnly, true);
  assert.equal(f.requests.some(x => x.data?.image === 'local'), false);
  const cloudWrite = f.requests.find(x => x.op === 'create');
  assert.equal(cloudWrite.data.client_id, 'private', 'wire client id must remain stable');
  f.sync.stopSync();
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('late A pull is aborted and cannot persist after logout and B login', async () => {
  const f = await fixture({ rows: [remote('A'), remote('B')] });
  const entered = deferred(); const release = deferred();
  f.hooks.list = async () => { delete f.hooks.list; entered.resolve(); await release.promise; };
  const old = f.login('A'); await entered.promise;
  const aRequest = f.requests[0];
  f.sync.stopSync(); await f.login('B');
  release.resolve(); await old;
  assert.equal(aRequest.options.signal.aborted, true);
  assert.deepEqual(Array.from(f.visible(), x => x.name), ['B private']);
  assert.equal(f.stored().some(x => x.cloudOwner === 'A'), false);
  assert.equal(f.sync.getSyncStatus().status, 'synced');
  f.sync.stopSync();
});

test('in-flight A lookup cannot create under B and requests pin auth tokens', async () => {
  const f = await fixture({ rows: [remote('A'), remote('B')] });
  const entered = deferred(); const release = deferred();
  f.hooks.find = async () => { delete f.hooks.find; entered.resolve(); await release.promise; };
  const old = f.login('A'); await entered.promise;
  f.sync.stopSync(); await f.login('B');
  release.resolve(); await old;
  assert.equal(f.requests.some(x => x.op === 'create' && x.data.owner === 'A'), false);
  for (const request of f.requests) {
    assert.equal(request.options.headers.Authorization, request.auth);
    assert.ok(request.options.signal);
  }
  assert.deepEqual(Array.from(f.visible(), x => x.name), ['B private']);
  f.sync.stopSync();
});

test('anonymous and local-only art stays visible and is never silently claimed', async () => {
  const items = [{ id: 'anon', name: 'anonymous', layer: 'anon' }, { id: 'private', localOnly: true, layer: 'local' }];
  const f = await fixture({ items });
  await f.login('A'); await f.login('B'); f.sync.stopSync();
  assert.deepEqual(Array.from(f.visible(), x => x.id), ['anon', 'private']);
  assert.equal(f.requests.some(x => x.op === 'create' || x.op === 'find'), false);
  assert.deepEqual(f.stored(), items);
});

test('unconfigured cloud makes no requests and anonymous persistence works', async () => {
  const f = await fixture({ configured: false, items: [{ id: 'anon', layer: 'local' }] });
  await f.login('A');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.sync.persistGallery([{ id: 'anon', layer: 'edited' }]))[0].layer, 'edited');
  assert.equal(f.stored()[0].layer, 'edited');
  await f.sync.persistGallery([...(await f.sync.readGallery()), { id: 'fresh-offline', layer: 'new' }]);
  f.sync.stopSync();
  assert.equal((await f.sync.readGallery()).length, 2, 'cloud-unset saves must stay anonymous');
});

test('gallery edits retain hidden owner partitions, consent and legacy quarantine', async () => {
  const f = await fixture({ items: [{ id: 'legacy', updated_at: '2026-01-01', layer: 'unknown' }, { id: 'anon', layer: 'local', localOnly: true }], rows: [remote('A'), remote('B')] });
  await f.login('A');
  const ownA = f.stored().find(x => x.cloudOwner === 'A');
  await f.login('B');
  await f.sync.persistGallery([...(await f.sync.readGallery()), { id: 'new', layer: 'B-new', localOnly: true }]);
  assert.deepEqual(f.stored().find(x => x.cloudOwner === 'A'), ownA);
  assert.equal(f.stored().find(x => x.id === 'legacy').layer, 'unknown');
  assert.equal(f.visible().some(x => x.id === 'legacy'), false);
  assert.equal(f.stored().find(x => x.id === 'new').localOnly, true);
  f.sync.stopSync();
});

test('new saves get immutable owners and stale persistence is discarded', async () => {
  const f = await fixture(); await f.login('A');
  const saved = await f.sync.persistGallery([{ id: 'new', layer: 'A-local' }]);
  assert.equal(saved[0]?.cloudOwner, 'A', 'UI receives immutable owner tags before it renders a saved item');
  assert.equal(f.stored()[0].cloudOwner, 'A');
  const entered = deferred(); const release = deferred();
  f.hooks.read = async () => { delete f.hooks.read; entered.resolve(); await release.promise; };
  const pending = f.sync.persistGallery([{ ...f.stored()[0], layer: 'stale' }]);
  await entered.promise;
  const loginB = f.login('B'); release.resolve();
  assert.equal(await pending, false); await loginB;
  assert.equal(f.stored().find(x => x.cloudOwner === 'A').layer, 'A-local');
  assert.equal(f.visible().length, 0);
  f.sync.stopSync();
});
