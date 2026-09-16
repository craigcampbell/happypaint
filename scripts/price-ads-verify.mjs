// Throwaway verification: boot server.js with scratch DATA_DIR, then assert the
// served billing config prices, the /ads.txt gate when unconfigured, and that the
// /family SEO description carries the new price. Deletes scratch on exit.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRATCH = await mkdtemp(join(tmpdir(), 'drawesome-price-verify-'));
let server;

async function waitFor(url, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch { /* boot */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server never answered ${url}`);
}

try {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '8943', DATA_DIR: SCRATCH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bootLog = '';
  server.stdout.on('data', (d) => { bootLog += d; });
  server.stderr.on('data', (d) => { bootLog += d; });
  const bootFailed = new Promise((_, reject) => {
    server.on('error', reject);
    server.on('exit', (code) => reject(new Error(`server exited early (${code}): ${bootLog.slice(-500)}`)));
  });

  await Promise.race([waitFor('http://127.0.0.1:8943/healthz'), bootFailed]);
  console.log('healthz: ok');
  server.removeAllListeners('exit');

  const config = await fetch('http://127.0.0.1:8943/api/billing/config').then((r) => r.json());
  console.log('billing display:', JSON.stringify(config.display), 'savings:', config.yearlySavingsPercent + '%');
  if (config.display.monthly !== '$1.99/month' || config.display.yearly !== '$15/year') {
    throw new Error('served prices do not match the new Family rates');
  }

  const ads404 = await fetch('http://127.0.0.1:8943/ads.txt');
  console.log('ads.txt (unset):', ads404.status);
  if (ads404.status !== 404) throw new Error('ads.txt must 404 when GAM_ADS_TXT_PUBLISHER_ID is unset');

  // Configured state on a second port: ads.txt must serve the GAM line.
  const server2 = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '8944', DATA_DIR: SCRATCH, GAM_ADS_TXT_PUBLISHER_ID: '123456789' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitFor('http://127.0.0.1:8944/healthz');
    const adsRes = await fetch('http://127.0.0.1:8944/ads.txt');
    const adsBody = await adsRes.text();
    console.log('ads.txt (set):', adsRes.status, JSON.stringify(adsBody.trim()));
    if (adsRes.status !== 200 || !adsBody.includes('google.com, 123456789, DIRECT, f08c47fec0942fa0')) {
      throw new Error('ads.txt must serve the GAM DIRECT line when configured');
    }
  } finally {
    const exited = new Promise((resolve) => {
      if (server2.exitCode !== null) return resolve();
      server2.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    server2.kill();
    await exited;
  }

  const familyHtml = await fetch('http://127.0.0.1:8943/family').then((r) => r.text());
  const metaOk = familyHtml.includes('$1.99 monthly or $15 yearly');
  console.log('/family meta description carries new price:', metaOk);
  if (!metaOk) throw new Error('/family SEO description still shows the old price');
  if (familyHtml.includes('4.99') || familyHtml.includes('$39')) {
    throw new Error('old price leaked into /family HTML');
  }
  console.log('old price absent from /family HTML: ok');

  console.log('PRICE-ADS VERIFY: ok');
} finally {
  if (server) {
    const exited = new Promise((resolve) => {
      if (server.exitCode !== null) return resolve();
      server.once('exit', resolve);
      setTimeout(resolve, 3000); // never hang the suite on a stubborn child
    });
    server.kill();
    await exited;
  }
  await rm(SCRATCH, { recursive: true, force: true });
}
