import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { WebSocket } from 'ws';

const dataDir = await mkdtemp(join(tmpdir(), 'drawesome-family-'));
const appPort = 18787 + Math.floor(Math.random() * 400);
const authPort = appPort + 500;
await writeFile(join(dataDir, '.billing.json'), JSON.stringify({
  version: 1,
  records: {
    parent_profile: {
      profileId: 'parent_profile',
      status: 'active',
      priceId: 'price_test_monthly',
      quantity: 1,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400,
    },
    unknown_profile: {
      profileId: 'unknown_profile',
      status: 'active',
      priceId: 'price_not_family',
      quantity: 1,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 86400,
    },
    grace_profile: {
      profileId: 'grace_profile',
      status: 'past_due',
      priceId: 'price_test_monthly',
      quantity: 1,
      pastDueSince: Date.now() - 60 * 60 * 1000,
      currentPeriodEnd: Math.floor(Date.now() / 1000) - 3600,
    },
    expired_profile: {
      profileId: 'expired_profile',
      status: 'past_due',
      priceId: 'price_test_monthly',
      quantity: 1,
      pastDueSince: Date.now() - 5 * 24 * 60 * 60 * 1000,
      currentPeriodEnd: Math.floor(Date.now() / 1000) - 86400,
    },
  },
}));

const authServer = http.createServer((req, res) => {
  const profiles = {
    'parent-token': 'parent_profile',
    'unknown-token': 'unknown_profile',
    'grace-token': 'grace_profile',
    'expired-token': 'expired_profile',
  };
  if (req.method === 'POST' && req.url.includes('/auth-refresh') && profiles[req.headers.authorization]) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ record: { id: profiles[req.headers.authorization], name: 'Parent' } }));
    return;
  }
  res.writeHead(401).end();
});
await new Promise((resolve) => authServer.listen(authPort, '127.0.0.1', resolve));

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(appPort),
    DATA_DIR: dataDir,
    PB_URL: `http://127.0.0.1:${authPort}`,
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRICE_FAMILY_MONTHLY: 'price_test_monthly',
    STRIPE_PRICE_FAMILY_YEARLY: 'price_test_yearly',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${appPort}/healthz`);
      if (res.ok) return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${stderr}`);
}

function connected(room, token = '') {
  return new Promise((resolve, reject) => {
    const suffix = token ? `&token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/ws?room=${room}${suffix}`);
    const timer = setTimeout(() => reject(new Error('websocket timeout')), 5000);
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'connected') {
        clearTimeout(timer);
        resolve({ ws, data });
      }
    });
    ws.on('error', reject);
  });
}

try {
  await waitForServer();
  const config = await fetch(`http://127.0.0.1:${appPort}/api/billing/config`).then((res) => res.json());
  assert.equal(config.configured, false, 'billing stays safely disabled without keys');

  const owner = await connected('FAM123', 'parent-token');
  assert.equal(owner.data.isOwner, true);
  assert.equal(owner.data.adFree, true, 'paid owner gets an ad-free private room');

  const guest = await connected('FAM123');
  assert.equal(guest.data.adFree, true, 'anonymous invitee inherits owner entitlement');

  const freeGuest = await connected('FREE12');
  assert.equal(freeGuest.data.adFree, false, 'ordinary anonymous rooms remain ad-supported');

  const unknownPlan = await connected('OTHER1', 'unknown-token');
  assert.equal(unknownPlan.data.adFree, false, 'an unrelated active Stripe price never grants Family');

  const grace = await connected('GRACE1', 'grace-token');
  assert.equal(grace.data.adFree, true, 'past-due Family gets the configured short grace period');

  const expired = await connected('LATE01', 'expired-token');
  assert.equal(expired.data.adFree, false, 'past-due Family loses access after the grace period');

  const publicRoom = await fetch(`http://127.0.0.1:${appPort}/api/rooms`, {
    method: 'POST',
    headers: { Authorization: 'Bearer parent-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ audience: 'kid_safe', title: 'Public test room' }),
  }).then((res) => res.json());
  const publicOwner = await connected(publicRoom.code, 'parent-token');
  assert.equal(publicOwner.data.adFree, false, 'Family applies only to private friends rooms');

  const scrub = await fetch(`http://127.0.0.1:${appPort}/api/account/scrub-chat`, {
    method: 'POST',
    headers: { Authorization: 'Bearer parent-token' },
  }).then((res) => res.json());
  assert.equal(scrub.billingScrubbed.removed, true, 'account erasure removes billing mapping');
  const stored = JSON.parse(await readFile(join(dataDir, '.billing.json'), 'utf8'));
  assert.equal(stored.records.parent_profile, undefined);

  owner.ws.close(); guest.ws.close(); freeGuest.ws.close(); unknownPlan.ws.close();
  grace.ws.close(); expired.ws.close(); publicOwner.ws.close();
  console.log('family entitlement integration: ok');
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => authServer.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
