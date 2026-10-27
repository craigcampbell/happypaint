import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/components/EventSharingReceipt.jsx', import.meta.url), 'utf8');
const action = source.slice(source.indexOf('  const remove = async () => {'), source.indexOf('\n  return <>'));

test('signed-in publisher can retry original device capability without account spoofing', async () => {
  const calls = []; const states = []; let removed;
  const context = { busy: false, id: 'wp_test', window: { confirm: () => true },
    getSession: async () => ({ access_token: 'test-account-token' }),
    localStorage: { getItem: () => 'u_original_device' },
    setBusy() {}, setMessage: (value) => states.push(value), setId() {},
    onRemoved: (id) => { removed = id; },
    fetch: async (url, options = {}) => { calls.push({ url, options }); const status = [403, 200, 404][calls.length - 1]; return { status, ok: status === 200 }; },
  };
  await vm.runInNewContext(`${action}\nremove();`, context);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-account-token');
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[1].options.body).userKey, 'u_original_device');
  assert.equal(removed, 'wp_test');
  assert(states.at(-1).includes('no longer public'));
});

test('receipt never retries a client-provided account key without authentication', async () => {
  let calls = 0;
  await vm.runInNewContext(`${action}\nremove();`, {
    busy: false, id: 'wp_test', window: { confirm: () => true },
    getSession: async () => ({ access_token: 'test-account-token' }),
    localStorage: { getItem: () => 'pb_someone_else' },
    setBusy() {}, setMessage() {}, setId() {},
    fetch: async () => { calls++; return { status: 403, ok: false }; },
  });
  assert.equal(calls, 1);
});
