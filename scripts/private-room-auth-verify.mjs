// Proves the two branches of "private rooms need a registered account":
//   A. accounts NOT configured (self-host / dev)  -> a guest can still enter an
//      invite-only room (the golden rule: the app works with the cloud unset);
//   B. accounts configured (PB_URL set)           -> a guest is refused with
//      signin_required, a real token gets in, and public rooms are unaffected.
//
// Spins two throwaway servers with scratch DATA_DIRs and a mock PocketBase that
// answers POST /api/collections/users/auth-refresh the way PocketBase does.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = 'C:/Users/Craig Campbell/Projects/happypaint';
const results = { checks: [], pass: 0, fail: 0 };
const check = (name, ok, extra = '') => {
  results.checks.push({ name, ok, extra });
  if (ok) results.pass += 1; else results.fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra && !ok ? ` — ${extra}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `pvr-${name}-`));

// --- mock PocketBase: the only endpoint the server calls ---------------------
const VALID_TOKEN = 'mock-valid-token';
const mock = http.createServer((req, res) => {
  if (req.url === '/api/collections/users/auth-refresh' && req.method === 'POST') {
    const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (raw === VALID_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ record: { id: 'profile_abc123', name: 'Test Grownup' } }));
      return;
    }
    res.writeHead(401).end('{}');
    return;
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;

function startServer(port, env) {
  const dir = tmp(String(port));
  const log = fs.openSync(path.join(dir, 'server.log'), 'w');
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: ['ignore', log, log],
  });
  return { proc, dir };
}
const waitHealthy = async (port) => {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  return false;
};

// Open a member socket and report the frames that matter.
function probe(port, room, token = null) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
    const seen = [];
    let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch {} resolve(seen); } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(String(raw));
        seen.push(m.type);
        if (m.type === 'connected' || m.type === 'signin_required' || m.type === 'blocked' || m.type === 'room_blocked') setTimeout(finish, 250);
      } catch { /* ignore */ }
    });
    ws.on('close', finish);
    ws.on('error', (e) => { seen.push(`error:${String(e.message).slice(0, 40)}`); finish(); });
    setTimeout(finish, 6000);
  });
}

// ---------- A. no accounts configured ----------
const a = startServer(8951, { PB_URL: '', POCKETBASE_URL: '' });
await waitHealthy(8951);
const aFrames = await probe(8951, 'PRIVT1');
check('A: guest CAN enter a private room when accounts are unconfigured', aFrames.includes('connected') && !aFrames.includes('signin_required'), JSON.stringify(aFrames));
const aMain = await probe(8951, 'MAIN');
check('A: guest still joins the public room', aMain.includes('connected'), JSON.stringify(aMain));
const aCreate = await fetch('http://127.0.0.1:8951/api/rooms', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ audience: 'kid_safe', title: 'anon public' }),
});
check('A: anonymous public room creation is allowed (golden rule)', aCreate.status === 200, `status ${aCreate.status}`);

// ---------- B. accounts configured ----------
const b = startServer(8952, { PB_URL: `http://127.0.0.1:${mockPort}` });
await waitHealthy(8952);
const bGuestPrivate = await probe(8952, 'PRIVT2');
check('B: guest is refused a private room (signin_required)', bGuestPrivate.includes('signin_required'), JSON.stringify(bGuestPrivate));
const bGuestPublic = await probe(8952, 'MAIN');
check('B: guest still joins public rooms (anonymous drawing intact)', bGuestPublic.includes('connected'), JSON.stringify(bGuestPublic));
const bBadToken = await probe(8952, 'PRIVT3', 'not-a-real-token');
check('B: an invalid token does NOT unlock a private room', bBadToken.includes('signin_required'), JSON.stringify(bBadToken));
const bGoodToken = await probe(8952, 'PRIVT4', VALID_TOKEN);
check('B: a real signed-in user enters the private room', bGoodToken.includes('connected') && !bGoodToken.includes('signin_required'), JSON.stringify(bGoodToken));
const bCreateAnon = await fetch('http://127.0.0.1:8952/api/rooms', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ audience: 'friends', title: 'guest private' }),
});
check('B: anonymous private room creation via API is refused', bCreateAnon.status === 401, `status ${bCreateAnon.status}`);
const bCreateAuth = await fetch('http://127.0.0.1:8952/api/rooms', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_TOKEN}` },
  body: JSON.stringify({ audience: 'friends', title: 'signed-in private' }),
});
check('B: signed-in private room creation works', bCreateAuth.status === 200, `status ${bCreateAuth.status}`);

// ---------- cleanup ----------
for (const s of [a, b]) { try { s.proc.kill(); } catch { /* gone */ } }
mock.close();
fs.writeFileSync(path.join(ROOT, 'captures', 'private-room-auth.json'), JSON.stringify(results, null, 1));
console.log(`\nprivate-room-auth: ${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
