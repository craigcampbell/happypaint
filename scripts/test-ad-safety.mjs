import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = await mkdtemp(join(tmpdir(), 'drawesome-ads-'));
const port = 19100 + Math.floor(Math.random() * 700);
const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    PB_URL: '',
    ADMIN_KEY: 'test-admin-key',
    ADS_SERVING_ENABLED: 'true',
    ADS_ALLOWED_COUNTRIES: 'US,ca,XX,not-a-country',
    ADS_ALLOW_UNKNOWN_COUNTRY: 'false',
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRODUCT_FAMILY: '',
    STRIPE_PRICE_FAMILY_MONTHLY: '',
    STRIPE_PRICE_FAMILY_YEARLY: '',
    STRIPE_PORTAL_CONFIGURATION_ID: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${stderr}`);
}

async function eligibility(country) {
  const headers = country ? { 'CF-IPCountry': country } : undefined;
  const response = await fetch(`http://127.0.0.1:${port}/api/ads/eligibility`, { headers });
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  return response.json();
}

try {
  await waitForServer();
  assert.deepEqual(await eligibility(), { eligible: false }, 'unknown locations fail ad-free');
  assert.deepEqual(await eligibility('DE'), { eligible: false }, 'countries outside the explicit list fail ad-free');
  assert.deepEqual(await eligibility('XX'), { eligible: false }, 'invalid edge country codes fail ad-free');
  assert.deepEqual(await eligibility('US'), { eligible: true }, 'an explicitly allowed country is eligible');
  assert.deepEqual(await eligibility('ca'), { eligible: true }, 'country matching is case-insensitive');

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/admin/ads`);
  assert.equal(unauthorized.status, 401, 'ad launch status is admin-only');
  const status = await fetch(`http://127.0.0.1:${port}/api/admin/ads`, {
    headers: { 'x-admin-key': 'test-admin-key' },
  }).then((response) => response.json());
  assert.equal(status.mode, 'eligible-regions-on');
  assert.deepEqual(status.allowedCountries, ['CA', 'US'], 'bad allowlist values are discarded');
  assert.equal(status.allowUnknownCountry, false);

  console.log('ad safety integration: ok');
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(dataDir, { recursive: true, force: true });
}
