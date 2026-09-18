// Proves the three things /admin needs to police private rooms, and the
// retention rule that goes with requiring an account for them:
//   1. a guest refused at a private room's door leaves NO room behind (phantoms
//      are reaped and never listed);
//   2. /api/admin/radar lists every private room — live AND asleep on disk —
//      with its owning account, and /api/admin/users-index hangs each account's
//      private rooms on its row; a moderator can Watch a dormant one without
//      resetting its idle clock;
//   3. an account-OWNED private room outlives the short guest TTL (30d floor),
//      while an unowned one and a long-dead owned one are still swept.
//
// Throwaway server, scratch DATA_DIR, mock PocketBase, ADMIN_KEY from env — the
// real key never appears here.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8957;
const KEY = 'verify-only-admin-key';
const DAY = 86_400_000;
const results = { checks: [], pass: 0, fail: 0 };
const check = (name, ok, extra = '') => {
  results.checks.push({ name, ok, extra });
  if (ok) results.pass += 1; else results.fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra && !ok ? ` — ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- mock PocketBase ---------------------------------------------------------
const VALID_TOKEN = 'mock-valid-token';
const PROFILE = 'profile_abc123';
const mock = http.createServer((req, res) => {
  if (req.url === '/api/collections/users/auth-refresh' && req.method === 'POST') {
    const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (raw === VALID_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ record: { id: PROFILE, name: 'Test Grownup' } }));
      return;
    }
    res.writeHead(401).end('{}');
    return;
  }
  res.writeHead(404).end('{}');
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

// --- seed the scratch data dir with rooms "from before the restart" ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvr-admin-'));
const roomsDir = path.join(dir, '.rooms');
fs.mkdirSync(roomsDir, { recursive: true });
const seed = (id, meta) => {
  fs.writeFileSync(path.join(roomsDir, `${id}.json`), JSON.stringify({ audience: 'friends', opCount: 10, userSeconds: 60, chat: [], ...meta }));
  fs.writeFileSync(path.join(roomsDir, `${id}.history.json`), JSON.stringify({ history: [] }));
};
const now = Date.now();
seed('OWNEDX', { ownerProfileId: PROFILE, title: 'Owned five days idle', savedAt: now - 5 * DAY, createdAt: now - 9 * DAY });
seed('GUESTX', { ownerProfileId: null, title: 'Guest-era five days idle', savedAt: now - 5 * DAY });
seed('OLDOWN', { ownerProfileId: PROFILE, title: 'Owned but dead 100 days', savedAt: now - 100 * DAY });

const log = fs.openSync(path.join(dir, 'server.log'), 'w');
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR: dir,
    ADMIN_KEY: KEY,
    PB_URL: `http://127.0.0.1:${mock.address().port}`,
    AUTO_CLOSE_SWEEP_MS: '1500',
    PHANTOM_ROOM_GRACE_MS: '2000',
  },
  stdio: ['ignore', log, log],
});
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  try { up = (await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok; } catch { /* not yet */ }
  if (!up) await sleep(250);
}
check('server boots', up);

const admin = async (p, key = KEY) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: { 'x-admin-key': key } });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const roomCount = async () => (await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json()).rooms;

// A member socket; resolves with the frames seen, optionally staying connected.
function member(room, token, holdMs = 250) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${room}`);
    const seen = [];
    let done = false;
    const finish = () => { if (!done) { done = true; try { ws.close(); } catch { /* gone */ } resolve(seen); } };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      try {
        const m = JSON.parse(String(raw));
        seen.push(m.type);
        if (m.type === 'connected' || m.type === 'signin_required') setTimeout(finish, holdMs);
      } catch { /* ignore */ }
    });
    ws.on('close', finish);
    ws.on('error', finish);
    setTimeout(finish, 6000);
  });
}
function modWatch(room, key) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${room}&modwatch=1`);
    let first = null;
    const finish = () => { try { ws.close(); } catch { /* gone */ } resolve(first); };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'mod_auth', key })));
    ws.on('message', (raw, isBinary) => {
      if (isBinary || first) return;
      try { const m = JSON.parse(String(raw)); first = m.type === 'mod_denied' ? `denied:${m.reason}` : m.type; } catch { /* ignore */ }
      setTimeout(finish, 300);
    });
    ws.on('error', finish);
    setTimeout(finish, 5000);
  });
}

// ---------- 1. the door, and what a refused guest leaves behind ----------
const before = await roomCount();
const guest = await member('PHANT1', null);
check('guest is refused a private room', guest.includes('signin_required') && !guest.includes('connected'), JSON.stringify(guest));
let radar = await admin('/api/admin/radar');
check('radar requires the admin key', (await admin('/api/admin/radar', 'wrong')).status === 401);
check('the refused guest\'s empty shell is not listed as a room', radar.status === 200 && !radar.body.rooms.some((r) => r.id === 'PHANT1'));
await sleep(4500);
check('…and it is reaped from memory', (await roomCount()) <= before, `before ${before}, after ${await roomCount()}`);

// ---------- 2. a signed-in owner, and what /admin can see ----------
const owner = await member('NEWPRV', VALID_TOKEN, 600);
check('signed-in user enters their private room', owner.includes('connected'), JSON.stringify(owner));
await sleep(3200); // let the ownership claim persist (2.5s write-behind)
radar = await admin('/api/admin/radar');
const live = radar.body.rooms.find((r) => r.id === 'NEWPRV');
check('radar: the new room is private and carries its owning account', !!live && live.audience === 'friends' && live.ownerKey === `pb:${PROFILE}` && live.dormant === false, JSON.stringify(live));
check('radar: an owned room is kept at least 30 days idle', !!live && live.keepsForMs >= 30 * DAY, String(live && live.keepsForMs));
check('a joined room survives the phantom sweep', !!live);

const asleep = radar.body.rooms.find((r) => r.id === 'OWNEDX');
check('radar: a DORMANT private room (on disk only) is listed with its owner', !!asleep && asleep.dormant === true && asleep.ownerKey === `pb:${PROFILE}` && asleep.title === 'Owned five days idle', JSON.stringify(asleep));
check('radar: dormant room shows ~25 days left, not 12 hours', !!asleep && asleep.expiresInMs > 20 * DAY && asleep.expiresInMs < 30 * DAY, String(asleep && asleep.expiresInMs));
check('radar totals count private rooms', radar.body.totals.private >= 2 && radar.body.totals.privateOwned >= 2 && radar.body.totals.dormant >= 1, JSON.stringify(radar.body.totals));

// ---------- 3. retention ----------
check('retention: owned room idle 5 days is KEPT', fs.existsSync(path.join(roomsDir, 'OWNEDX.json')));
check('retention: unowned room idle 5 days is swept', !fs.existsSync(path.join(roomsDir, 'GUESTX.json')));
check('retention: owned room idle 100 days is swept (bounded, not forever)', !fs.existsSync(path.join(roomsDir, 'OLDOWN.json')));

// ---------- 4. the per-user view ----------
const users = await admin(`/api/admin/users-index?q=${encodeURIComponent(`pb:${PROFILE}`)}`);
const row = users.body && users.body.users.find((u) => u.userKey === `pb:${PROFILE}`);
const mine = (row && row.privateRooms) || [];
check('users: the account row lists the private room it just made, as OWNER', mine.some((r) => r.room === 'NEWPRV' && r.owned && r.visits >= 1), JSON.stringify(mine));
check('users: …and the dormant one it owns but has not visited this era', mine.some((r) => r.room === 'OWNEDX' && r.owned && r.dormant), JSON.stringify(mine));
check('users: public rooms never appear as private', !mine.some((r) => r.room === 'MAIN'));
check('users: totals report private rooms', users.body.totals.privateRooms >= 2 && users.body.totals.privateRoomOwners >= 1, JSON.stringify(users.body.totals));
const byCode = await admin('/api/admin/users-index?q=ownedx');
check('users: searching a private room code finds its owner', !!byCode.body && byCode.body.users.some((u) => u.userKey === `pb:${PROFILE}`));

// ---------- 5. watching a dormant private room ----------
check('mod watch: a bad key cannot load a dormant room', String(await modWatch('OWNEDX', 'wrong')).startsWith('denied'));
check('mod watch: a room that does not exist is still refused', (await modWatch('NOSUCH', KEY)) === 'denied:no_room');
check('mod watch: the real key opens a dormant private room', (await modWatch('OWNEDX', KEY)) === 'connected');
radar = await admin('/api/admin/radar');
const woken = radar.body.rooms.find((r) => r.id === 'OWNEDX');
check('…it is now loaded, and looking did NOT reset its idle clock', !!woken && woken.dormant === false && now - woken.lastActivity > 4 * DAY, JSON.stringify(woken && { dormant: woken.dormant, lastActivity: woken.lastActivity }));
await sleep(2000);
check('…and the sweep still leaves it alone', fs.existsSync(path.join(roomsDir, 'OWNEDX.json')) && (await admin('/api/admin/radar')).body.rooms.some((r) => r.id === 'OWNEDX'));

// ---------- cleanup ----------
try { proc.kill(); } catch { /* gone */ }
mock.close();
try { fs.mkdirSync(path.join(ROOT, 'captures'), { recursive: true }); } catch { /* exists */ }
fs.writeFileSync(path.join(ROOT, 'captures', 'private-rooms-admin.json'), JSON.stringify(results, null, 1));
console.log(`\nprivate-rooms-admin: ${results.pass} passed, ${results.fail} failed`);
process.exit(results.fail ? 1 : 0);
