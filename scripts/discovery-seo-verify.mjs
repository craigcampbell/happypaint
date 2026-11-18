// Real HTTP regression gate: run after npm run build. Synthetic data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { DISCOVERY_PATHS } from '../src/data/discoverySeo.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(join(tmpdir(), 'drawesome-seo-'));
const port = 9181;
const origin = `http://127.0.0.1:${port}`;
const oldPaths = ['/', '/studio', '/rooms', '/wall', '/inktober', '/planet', '/paintjar', '/gallery', '/about', '/family', '/faq', '/safety', '/parents', '/privacy', '/signup'];
let output = '';
const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data, PB_URL: '', PUBLIC_ORIGIN: 'https://drawesome.art', TRUSTED_PROXY_HOSTS: '', ENABLE_CLIENT_SNAPSHOTS: '', ENABLE_TRUSTED_CHECKPOINTS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
let count = 0;
function check(value, name) { assert.ok(value, name); count += 1; console.log(`PASS ${name}`); }
try {
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(output);
    try { ready = (await fetch(`${origin}/healthz`)).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(ready, 'isolated server ready');
  const map = await (await fetch(`${origin}/sitemap.xml`)).text();
  const urls = [...map.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]);
  check(urls.length === new Set(urls).size, 'no duplicate sitemap URLs');
  for (const path of oldPaths) check(urls.includes(`https://drawesome.art${path}`), `preserved sitemap ${path}`);
  for (const path of DISCOVERY_PATHS) check(urls.includes(`https://drawesome.art${path}`), `discoverable ${path}`);
  const robots = await (await fetch(`${origin}/robots.txt`)).text();
  check(robots.includes('Disallow: /join/') && robots.includes('Disallow: /watch/'), 'private room exclusions preserved');
  check(robots.includes('Sitemap: https://drawesome.art/sitemap.xml'), 'sitemap declaration preserved');
  for (const path of [...new Set([...oldPaths, ...DISCOVERY_PATHS])]) {
    const res = await fetch(`${origin}${path}`);
    const html = await res.text();
    check(res.status === 200, `${path} serves 200`);
    check(html.includes(`href="https://drawesome.art${path}" data-seo="canonical"`), `${path} self canonical`);
    check(/<title[^>]*>[^<]+<\/title>/.test(html), `${path} title`);
    check(html.includes('G-9TG5C3N1YP'), `${path} analytics preserved`);
    if (DISCOVERY_PATHS.includes(path) || path === '/') {
      check(html.includes('data-discovery-landing') && html.includes('<h1>'), `${path} useful content without JavaScript`);
      check(html.includes('href="/gallery"') && html.includes('href="/events"'), `${path} crawlable navigation`);
    }
  }
  const filtered = await (await fetch(`${origin}/gallery?event=little-joys&q=cat`)).text();
  check(filtered.includes('href="https://drawesome.art/gallery" data-seo="canonical"'), 'filters do not create duplicate canonical pages');
  const unknown = await fetch(`${origin}/events/not-a-real-event`);
  check(unknown.status === 404, 'unknown event is not a soft 404');
  const invitation = await fetch(`${origin}/sketchbook/invite/not-a-real-token`);
  check((invitation.headers.get('x-robots-tag') || '').includes('noindex') || /name="robots"[^>]*noindex/.test(await invitation.text()), 'invitation pages not indexed');
  console.log(`SEO HTTP regression: ${count} checks passed`);
} catch (error) {
  console.error(output.slice(-5000));
  throw error;
} finally {
  const exited = once(child, 'exit');
  if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
  await rm(data, { recursive: true, force: true });
}
