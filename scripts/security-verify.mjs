// Regression harness for the 2026-09 security audit. Every check is an attack
// from the audit, run against throwaway servers (scratch DATA_DIR, mock
// PocketBase, env ADMIN_KEY):
//   server A — TRUSTED_PROXY_HOSTS names an address that is NOT our peer, so
//              cf-connecting-ip must be ignored (the "origin reached directly"
//              case), plus tiny gallery ceiling + join-miss budget.
//   server B — trusts loopback, i.e. behaves like production behind the tunnel.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'verify-only-admin-key';
const results = { checks: [], pass: 0, fail: 0 };
const check = (name, ok, extra = '') => {
  results.checks.push({ name, ok, extra });
  if (ok) results.pass += 1; else results.fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra && !ok ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real 1×1 PNG, the same bytes as an SVG would-be "image", and a hostile URL.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const BIG_PNG = PNG.replace(/=+$/, '') + 'A'.repeat(6000);
const SVG = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
const LIAR = `data:image/png;base64,${Buffer.from('<html>this is not a png at all, just text</html>').toString('base64')}`;
const TRACKER = 'https://attacker.example/track.png';

// --- mock PocketBase: one good token whose validity we can revoke ------------
const VALID_TOKEN = 'mock-valid-token';
const PROFILE = 'profile_sec123';
let tokenAlive = true;
const mock = http.createServer((req, res) => {
  const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (req.url === '/api/collections/users/auth-refresh' && raw === VALID_TOKEN && tokenAlive) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ record: { id: PROFILE, name: 'Sec Tester' } }));
    return;
  }
  res.writeHead(401).end('{}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const PB = `http://127.0.0.1:${mock.address().port}`;

function boot(port, env, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sec-${port}-`));
  if (seed) seed(dir);
  const log = fs.openSync(path.join(dir, 'server.log'), 'w');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMIN_KEY: KEY, PB_URL: PB, HOST: '', ...env },
    stdio: ['ignore', log, log],
  });
  return { proc, dir, port, base: `http://127.0.0.1:${port}` };
}
async function healthy(s) {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${s.base}/healthz`)).ok) return true; } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}
const seedFilm = (dir) => {
  const rooms = path.join(dir, '.rooms');
  fs.mkdirSync(rooms, { recursive: true });
  fs.writeFileSync(path.join(rooms, 'FILMPV.json'), JSON.stringify({ audience: 'friends', animation: true, ownerProfileId: PROFILE, title: 'Secret film', savedAt: Date.now(), opCount: 0, chat: [] }));
  fs.writeFileSync(path.join(rooms, 'FILMPV.history.json'), JSON.stringify({ history: [] }));
};

const A = boot(8971, { TRUSTED_PROXY_HOSTS: '203.0.113.9', ARTWORK_DIR_MAX_BYTES: '3000', JOIN_MISS_PER_MIN: '5' });
const B = boot(8972, { TRUSTED_PROXY_HOSTS: '127.0.0.1' }, seedFilm);
check('servers boot', (await healthy(A)) && (await healthy(B)));

const saveArt = (s, body, headers = {}) => fetch(`${s.base}/api/artworks`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
const uk = (i) => `u_sec${i}${Date.now().toString(36)}`;

// ---------- 6. response hardening ----------
{
  const shell = await fetch(`${B.base}/admin`);
  const api = await fetch(`${B.base}/api/rooms/public`);
  const ok = (r) => r.headers.get('x-content-type-options') === 'nosniff'
    && r.headers.get('x-frame-options') === 'SAMEORIGIN'
    && /frame-ancestors 'self'/.test(r.headers.get('content-security-policy') || '');
  check('SPA shell (/admin) cannot be framed and is nosniff', ok(shell), JSON.stringify([...shell.headers]));
  check('API responses carry the same headers', ok(api));
  check('x-powered-by is gone', !shell.headers.get('x-powered-by'));
}

// ---------- 1. gallery: bytes, rate, ceiling ----------
check('gallery refuses an SVG "image"', (await saveArt(B, { userKey: uk('a'), image: SVG })).status === 400);
check('gallery refuses bytes that are not the image they claim', (await saveArt(B, { userKey: uk('b'), image: LIAR })).status === 400);
check('gallery refuses a URL', (await saveArt(B, { userKey: uk('c'), image: TRACKER })).status === 400);
{
  const good = await saveArt(B, { userKey: uk('d'), image: PNG, thumb: SVG, name: 'ok' });
  check('gallery still saves a real PNG', good.status === 200, `status ${good.status}`);
}
check('gallery ceiling: a save that would overflow the directory is refused (507)', (await saveArt(A, { userKey: uk('e'), image: BIG_PNG })).status === 507);
check('…while a small one under the ceiling is fine', (await saveArt(A, { userKey: uk('f'), image: PNG })).status === 200);

// ---------- 2. whose cf-connecting-ip is believed ----------
{
  // A does not trust our peer: rotating the header must NOT mint fresh buckets.
  let limitedAt = 0;
  for (let i = 1; i <= 45 && !limitedAt; i += 1) {
    const r = await saveArt(A, { userKey: uk(`g${i}`), image: 'x' }, { 'cf-connecting-ip': `198.51.100.${i}` });
    if (r.status === 429) limitedAt = i;
  }
  check('untrusted peer: a rotated cf-connecting-ip does not dodge the per-IP limit', limitedAt > 0 && limitedAt <= 41, `limited at ${limitedAt}`);
  // B trusts loopback (the tunnel case): distinct visitors get distinct buckets…
  let bLimited = false;
  for (let i = 1; i <= 45; i += 1) {
    const r = await saveArt(B, { userKey: uk(`h${i}`), image: 'x' }, { 'cf-connecting-ip': `198.51.100.${i}` });
    if (r.status === 429) bLimited = true;
  }
  check('trusted peer: real visitors behind the tunnel are limited separately', !bLimited);
  // …but a header that is not an IP is never used as a key.
  let junkLimited = 0;
  for (let i = 1; i <= 45 && !junkLimited; i += 1) {
    const r = await saveArt(B, { userKey: uk(`j${i}`), image: 'x' }, { 'cf-connecting-ip': `junk-${i}` });
    if (r.status === 429) junkLimited = i;
  }
  check('a non-IP header value falls back to the peer address', junkLimited > 0, `limited at ${junkLimited}`);
}
{
  // Bare `node server.js` must not listen on the LAN.
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) {
    check('default bind is loopback-only (no LAN interface to test — skipped)', true);
  } else {
    const reachable = await new Promise((resolve) => {
      const sock = net.connect({ host: lan.address, port: B.port });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
      setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
    });
    check(`default bind is loopback-only (not reachable on ${lan.address})`, !reachable);
  }
}

// ---------- 3. ops that make every member's browser load a URL ----------
function member(s, room, token, query = '') {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?room=${room}${query}`);
    const msgs = [];
    ws.on('message', (raw, isBinary) => { if (!isBinary) { try { msgs.push(JSON.parse(String(raw))); } catch { /* ignore */ } } });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 700);
    });
    ws.on('error', () => resolve({ ws, msgs, send: () => {} }));
  });
}
{
  const alice = await member(B, 'SECOP1', VALID_TOKEN);
  const bob = await member(B, 'SECOP1', VALID_TOKEN);
  check('two members are in the private room', alice.msgs.some((m) => m.type === 'connected') && bob.msgs.some((m) => m.type === 'connected'));
  const gotOp = (pred) => bob.msgs.some((m) => m.type === 'op' && m.op && pred(m.op));
  const stroke = (id, dab) => ({ kind: 'draw', strokeId: id, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], settings: { brush: 'pen', size: 8, color: '#000000', dab } });

  alice.send({ type: 'op', op: { kind: 'image', dataUrl: TRACKER, x: 0, y: 0, w: 50, h: 50 } });
  alice.send({ type: 'op', op: { kind: 'image', dataUrl: SVG, x: 0, y: 0, w: 50, h: 50 } });
  alice.send({ type: 'op', op: { kind: 'image', dataUrl: LIAR, x: 0, y: 0, w: 50, h: 50 } });
  alice.send({ type: 'op', op: stroke('s-evil', { shape: 'stamp', stampId: 'evil', stampDataUrl: TRACKER }) });
  await sleep(700);
  check('an image op pointing at a remote URL is never relayed', !gotOp((op) => op.dataUrl === TRACKER));
  check('…nor an SVG, nor mislabelled bytes', !gotOp((op) => op.dataUrl === SVG || op.dataUrl === LIAR));
  check('a stamp brush whose tip is a remote URL is never relayed', !gotOp((op) => op.strokeId === 's-evil'));

  alice.send({ type: 'op', op: { kind: 'image', dataUrl: PNG, x: 0, y: 0, w: 50, h: 50 } });
  alice.send({ type: 'op', op: stroke('s-good', { shape: 'stamp', stampId: 'good', stampDataUrl: PNG }) });
  alice.send({ type: 'op', op: stroke('s-plain', undefined) });
  await sleep(700);
  check('a real inline PNG image op still reaches the room', gotOp((op) => op.kind === 'image' && op.dataUrl === PNG));
  check('a stamp brush with an inline PNG tip still draws', gotOp((op) => op.strokeId === 's-good'));
  check('ordinary strokes are untouched', gotOp((op) => op.strokeId === 's-plain'));

  const late = await member(B, 'SECOP1', VALID_TOKEN);
  await sleep(500);
  const replayed = JSON.stringify(late.msgs);
  check('nothing hostile was stored for future joiners either', !replayed.includes('attacker.example') && !replayed.includes('svg+xml'));
  for (const c of [alice, bob, late]) c.ws.close();
}

// ---------- 6. the socket no longer reads ?token= ----------
{
  const c = await member(B, 'SECTK1', null, `&token=${VALID_TOKEN}`);
  check('a token in the WS URL does not authenticate', c.msgs.some((m) => m.type === 'signin_required') && !c.msgs.some((m) => m.type === 'connected'), JSON.stringify(c.msgs.map((m) => m.type)));
  c.ws.close();
}

// ---------- 4. private film history ----------
{
  const film = (headers) => fetch(`${B.base}/api/rooms/FILMPV/film`, { headers });
  check('private film: no account → 401', (await film({})).status === 401);
  const mine = await film({ Authorization: `Bearer ${VALID_TOKEN}` });
  check('private film: signed-in member → 200', mine.status === 200, `status ${mine.status}`);
  check('public film (FLIPBOOK) stays open to guests', (await fetch(`${B.base}/api/rooms/FLIPBOOK/film`)).status === 200);
  // the limiter is per VISITOR now, not one global bucket
  let drained = 0;
  for (let i = 0; i < 12 && !drained; i += 1) {
    const r = await fetch(`${B.base}/api/rooms/FLIPBOOK/film`, { headers: { 'cf-connecting-ip': '198.51.100.200' } });
    if (r.status === 429) drained = i + 1;
  }
  const other = await fetch(`${B.base}/api/rooms/FLIPBOOK/film`, { headers: { 'cf-connecting-ip': '198.51.100.201' } });
  check('one visitor draining the film limiter does not lock out the next', drained > 0 && other.status === 200, `drained at ${drained}, other ${other.status}`);
}

// ---------- 5. scrub-chat cannot be looped ----------
{
  const scrub = () => fetch(`${B.base}/api/account/scrub-chat`, { method: 'POST', headers: { Authorization: `Bearer ${VALID_TOKEN}`, 'cf-connecting-ip': '198.51.100.220' } });
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await scrub()).status);
  check('scrub-chat: 3 per account per hour, then 429', codes.slice(0, 3).every((c) => c === 200) && codes.slice(3).every((c) => c === 429), JSON.stringify(codes));
}

// ---------- 6. a block / revocation beats the token cache ----------
{
  const film = () => fetch(`${B.base}/api/rooms/FILMPV/film`, { headers: { Authorization: `Bearer ${VALID_TOKEN}`, 'cf-connecting-ip': '198.51.100.210' } });
  const adminPost = (p) => fetch(`${B.base}${p}`, { method: 'POST', headers: { 'x-admin-key': KEY, 'Content-Type': 'application/json' }, body: '{}' });
  const blockUrl = `/api/admin/users/${encodeURIComponent(`pb:${PROFILE}`)}`;
  await adminPost(`${blockUrl}/block`);
  check('a blocked account is refused private film history', (await film()).status === 403);
  await adminPost(`${blockUrl}/unblock`);
  check('…and gets it back when unblocked', (await film()).status === 200); // also warms the 60s cache
  tokenAlive = false; // PocketBase would now reject this token, but the cache still says yes
  await adminPost(`${blockUrl}/block`);
  await adminPost(`${blockUrl}/unblock`);
  check('the block dropped the cached token (re-verified, now rejected)', (await film()).status === 401);
  tokenAlive = true;
}

// ---------- 6. code guessing ----------
{
  const seen = [];
  for (let i = 0; i < 9; i += 1) {
    const c = await member(A, `GUESS${i}X`, null);
    seen.push(c.msgs.map((m) => m.type).join(','));
    c.ws.close();
  }
  check('join-miss budget: guessing fresh codes gets rate-limited', seen.slice(0, 5).every((t) => t.includes('signin_required')) && seen.slice(5).some((t) => t.includes('rate_limited')), JSON.stringify(seen));
  const main = await member(A, 'MAIN', null);
  check('…while real rooms stay joinable', main.msgs.some((m) => m.type === 'connected'));
  main.ws.close();
}

for (const s of [A, B]) { try { s.proc.kill(); } catch { /* gone */ } }
mock.close();
try { fs.mkdirSync(path.join(ROOT, 'captures'), { recursive: true }); } catch { /* exists */ }
fs.writeFileSync(path.join(ROOT, 'captures', 'security-verify.json'), JSON.stringify(results, null, 1));
console.log(`\nsecurity-verify: ${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
