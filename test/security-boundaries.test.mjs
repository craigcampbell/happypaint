import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { isIP } from 'node:net';
import http from 'node:http';
import { verifyAccessToken } from '../server/pocketbaseAuth.js';

const source = await readFile(process.env.SERVER_SOURCE || new URL('../server.js', import.meta.url), 'utf8');
function proxyPolicy(hosts, lookup) {
  const start = source.indexOf('const TRUSTED_PROXY_HOSTS =');
  const end = source.indexOf('\nfunction clientIp(', start);
  assert.ok(start >= 0 && end > start, 'real server policy is present');
  const context = vm.createContext({ process: { env: { TRUSTED_PROXY_HOSTS: hosts } }, isIP, dnsPromises: { lookup }, setInterval: () => ({ unref() {} }) });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.policy = { refreshTrustedProxies, forwardedClientIp };', context);
  return context.policy;
}
test('configured proxy DNS failure never trusts an arbitrary private peer', async () => {
  const policy = proxyPolicy('tunnel.invalid', async () => { throw new Error('DNS unavailable'); });
  await new Promise(resolve => setImmediate(resolve));
  await policy.refreshTrustedProxies();
  for (const peer of ['127.0.0.1', '172.19.0.99', '10.2.3.4', '::1']) {
    assert.equal(policy.forwardedClientIp('8.8.8.8', peer), peer);
  }
});
test('configured proxies trust exact resolved addresses, not private siblings; refresh removes stale trust', async () => {
  let available = true;
  const policy = proxyPolicy('tunnel', async () => { if (!available) throw new Error('DNS failed'); return [{ address: '172.19.0.2' }]; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(policy.forwardedClientIp('8.8.8.8', '172.19.0.2'), '8.8.8.8');
  assert.equal(policy.forwardedClientIp('8.8.8.8', '172.19.0.3'), '172.19.0.3');
  available = false;
  await policy.refreshTrustedProxies();
  assert.equal(policy.forwardedClientIp('8.8.8.8', '172.19.0.2'), '172.19.0.2');
});
test('unconfigured local tunnel policy and malformed-header rejection remain compatible', () => {
  const policy = proxyPolicy('', async () => []);
  assert.equal(policy.forwardedClientIp('8.8.8.8', '127.0.0.1'), '8.8.8.8');
  assert.equal(policy.forwardedClientIp('8.8.8.8', '9.9.9.9'), '9.9.9.9');
  assert.equal(policy.forwardedClientIp('not-an-ip', '127.0.0.1'), '127.0.0.1');
});
test('hanging PocketBase response body has a bounded auth deadline and fails anonymous', { timeout: 7000 }, async () => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const before = process.env.PB_URL;
  process.env.PB_URL = `http://127.0.0.1:${server.address().port}`;
  const start = Date.now();
  try {
    const result = await Promise.race([verifyAccessToken('synthetic-timeout-token'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('auth exceeded safe deadline')), 5000); timer.unref(); })]);
    assert.equal(result, null);
    assert.ok(Date.now() - start < 4500);
  } finally {
    if (before === undefined) delete process.env.PB_URL; else process.env.PB_URL = before;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
