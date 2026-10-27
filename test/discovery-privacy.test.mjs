import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function syncHarness(local, remote = []) {
  const writes = [];
  let stored = local;
  const pb = { collection: () => ({
    getFullList: async () => remote,
    getFirstListItem: async () => { throw { status: 404 }; },
    create: async (item) => writes.push(item),
    update: async (_id, item) => writes.push(item),
  }) };
  const source = readFileSync(new URL('../src/utils/sync.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({
    getPocketBase: async () => pb, getProfileId: async () => 'fixture-owner',
    idbGetKV: async () => stored, idbSetKV: async (_key, value) => { stored = value; },
    isIdbAvailable: () => true, setTimeout, clearTimeout, console,
  });
  vm.runInContext(`${source}\nglobalThis.run = startSync;`, context);
  await context.run({ user: { id: 'fixture-owner' } });
  return { writes, stored };
}

test('later signed-in room sync never uploads local-only drawings', async () => {
  const {writes} = await syncHarness([
    {id:'private',localOnly:true,layer:'PRIVATE_PIXELS'},
    {id:'ordinary',layer:'SHARED_PIXELS'},
  ]);
  assert.deepEqual(writes.map((item) => item.client_id), ['ordinary']);
});

test('newer remote snapshot cannot remove local-only protection during pull', async () => {
  const {writes,stored} = await syncHarness(
    [{id:'private',localOnly:true,layer:'PRIVATE_PIXELS',createdAt:'2020-01-01'}],
    [{client_id:'private',image:'REMOTE',client_updated:'2030-01-01'}],
  );
  assert.equal(stored[0].localOnly,true);
  assert.equal(stored[0].layer,'PRIVATE_PIXELS');
  assert.equal(writes.length,0);
});
