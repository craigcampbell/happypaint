// Happy Paint — realtime multiplayer + static host (single process).
//
// In production this serves the built `dist/` SPA AND a WebSocket relay on the
// same port, so a single Cloudflare tunnel route (drawesome.art -> localhost)
// covers both the page load and the live drawing socket.
//
// The relay is deliberately op-agnostic: clients send small "op" messages
// (incremental brush points, shapes, text) that the server stores per-room and
// rebroadcasts to everyone else. Late joiners get the stored op history replayed
// so they see the shared canvas as it stands. Cursors and chat are relayed but
// not stored.

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 6000);
const MAX_ROOM_USERS = Number(process.env.MAX_ROOM_USERS || 30);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Rooms ----------------------------------------------------------------
// Each room keeps its connected users and a capped op history for replay.
const rooms = new Map();

// ---- Health instrumentation -----------------------------------------------
// Event-loop delay (how late the loop is firing — the best "is the server
// straining?" signal), CPU%, and an all-time peak-concurrent-users counter.
const ELD_RESOLUTION_MS = 20;
const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
eld.enable();
// The OS timer granularity (≈15.6ms on Windows) gives every sample a fixed
// floor, so even a totally idle loop reports ~30ms here. We learn that floor
// from the smallest delay ever observed and subtract it, so the number we show
// is *excess* lag: ~0 when healthy, climbing only when the loop is genuinely
// backed up. Self-calibrating, so it's honest on Windows and Linux alike.
let loopFloorMs = Infinity;
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

const METRICS_FILE = join(__dirname, '.metrics.json');
let peakUsers = 0;
let peakAt = 0;
try {
  const saved = JSON.parse(readFileSync(METRICS_FILE, 'utf8'));
  peakUsers = saved.peakUsers || 0;
  peakAt = saved.peakAt || 0;
} catch {
  peakUsers = 0;
}
function persistPeak() {
  try { writeFileSync(METRICS_FILE, JSON.stringify({ peakUsers, peakAt })); } catch { /* ignore */ }
}
function totalUsers() {
  let n = 0;
  rooms.forEach((room) => { n += room.users.size; });
  return n;
}
function notePeak() {
  const t = totalUsers();
  if (t > peakUsers) {
    peakUsers = t;
    peakAt = Date.now();
    persistPeak();
  }
}

// Per-room mural persistence: the op history is written to disk (debounced) and
// reloaded on startup, so a server restart doesn't wipe the painting and late
// joiners always replay the full mural.
const ROOM_DIR = process.env.ROOM_DIR || join(__dirname, '.rooms');
const persistTimers = new Map();
function roomFile(roomId) {
  return join(ROOM_DIR, `${String(roomId).replace(/[^A-Z0-9_-]/gi, '').slice(0, 32)}.json`);
}
function loadRoom(roomId) {
  try {
    const data = JSON.parse(readFileSync(roomFile(roomId), 'utf8'));
    return { history: Array.isArray(data.history) ? data.history : [], sheetId: data.sheetId || null };
  } catch {
    return { history: [], sheetId: null };
  }
}
function persistRoom(roomId) {
  if (persistTimers.has(roomId)) {
    return;
  }
  persistTimers.set(roomId, setTimeout(() => {
    persistTimers.delete(roomId);
    const room = rooms.get(roomId);
    if (!room) {
      return;
    }
    try {
      mkdirSync(ROOM_DIR, { recursive: true });
      writeFileSync(roomFile(roomId), JSON.stringify({ history: room.history, sheetId: room.sheetId || null, savedAt: Date.now() }));
    } catch {
      // Non-fatal — persistence is best-effort.
    }
  }, 2500));
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const saved = loadRoom(roomId);
    rooms.set(roomId, { users: new Map(), history: saved.history, lastCleared: null, sheetId: saved.sheetId, lastActivity: Date.now() });
  }
  return rooms.get(roomId);
}

const ANIMAL_NAMES = [
  'Fox', 'Otter', 'Panda', 'Robin', 'Koala', 'Tiger', 'Bunny', 'Whale',
  'Lynx', 'Finch', 'Newt', 'Wren', 'Yak', 'Lark', 'Seal', 'Crow',
];
const USER_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#F8961E',
  '#DDA0DD', '#118AB2', '#06D6A0', '#EF476F', '#9B5DE5',
  '#F15BB5', '#00BBF9', '#FEE440', '#8AC926', '#FF924C',
];

let userSeed = 0;
function nextUserId() {
  userSeed += 1;
  return `u${Date.now().toString(36)}${userSeed}`;
}
function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function userListOf(room) {
  return Array.from(room.users.values()).map((u) => ({ id: u.id, name: u.name, color: u.color }));
}

function broadcast(roomId, message, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(message);
  room.users.forEach((u) => {
    if (u.id !== exceptId && u.ws.readyState === 1) {
      u.ws.send(data);
    }
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get('room') || 'MAIN').toUpperCase().slice(0, 16);
  const room = getRoom(roomId);

  if (room.users.size >= MAX_ROOM_USERS) {
    ws.send(JSON.stringify({ type: 'room_full', max: MAX_ROOM_USERS }));
    ws.close(1008, 'room full');
    return;
  }

  const id = nextUserId();
  const name = pick(ANIMAL_NAMES);
  const color = pick(USER_COLORS);
  const user = { id, name, color, ws, connectedAt: Date.now(), lastActivity: Date.now() };
  room.users.set(id, user);
  room.lastActivity = Date.now();
  notePeak();
  ws.roomId = roomId;
  ws.userId = id;

  ws.send(JSON.stringify({ type: 'connected', userId: id, userName: name, userColor: color, roomId }));
  ws.send(JSON.stringify({ type: 'userList', users: userListOf(room) }));
  if (room.history.length > 0) {
    ws.send(JSON.stringify({ type: 'history', ops: room.history }));
  }
  if (room.sheetId) {
    ws.send(JSON.stringify({ type: 'sheet', sheetId: room.sheetId }));
  }
  broadcast(roomId, { type: 'userJoined', user: { id, name, color }, userList: userListOf(room) }, id);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    user.lastActivity = Date.now();
    room.lastActivity = Date.now();

    switch (data.type) {
      case 'op': {
        if (!data.op) break;
        // Tag with the author so replay/cursors can attribute it.
        const op = { ...data.op, userId: id };
        room.history.push(op);
        if (room.history.length > MAX_HISTORY) {
          room.history.splice(0, room.history.length - MAX_HISTORY);
        }
        broadcast(roomId, { type: 'op', op }, id);
        persistRoom(roomId);
        break;
      }
      case 'cursor':
        broadcast(roomId, {
          type: 'cursor', userId: id, name: user.name, color: user.color,
          x: data.x, y: data.y, drawing: !!data.drawing,
        }, id);
        break;
      case 'set_sheet':
        // Set (or clear) the room's coloring sheet for everyone.
        room.sheetId = data.sheetId ? String(data.sheetId).slice(0, 64) : null;
        broadcast(roomId, { type: 'sheet', sheetId: room.sheetId });
        persistRoom(roomId);
        break;
      case 'rename': {
        if (typeof data.name === 'string' && data.name.trim()) {
          user.name = data.name.trim().slice(0, 20);
        }
        if (typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) {
          user.color = data.color;
        }
        broadcast(roomId, { type: 'userList', users: userListOf(room) });
        break;
      }
      case 'clear':
        // Keep a backup so the room can undo a clear (everyone gets mad otherwise).
        room.lastCleared = room.history;
        room.history = [];
        broadcast(roomId, { type: 'clear', userId: id, name: user.name }, id);
        persistRoom(roomId);
        break;
      case 'undo_clear':
        // Restore the most recently cleared mural for the whole room.
        if (room.lastCleared && room.lastCleared.length) {
          room.history = room.lastCleared;
          room.lastCleared = null;
          broadcast(roomId, { type: 'history', ops: room.history, restored: true });
          persistRoom(roomId);
        }
        break;
      case 'chat':
        if (typeof data.message === 'string' && data.message.trim()) {
          broadcast(roomId, {
            type: 'chat', user: { id, name: user.name, color: user.color },
            message: String(data.message).slice(0, 300), ts: Date.now(),
          });
        }
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    room.users.delete(id);
    broadcast(roomId, { type: 'cursor_leave', userId: id });
    broadcast(roomId, { type: 'userLeft', userId: id, userList: userListOf(room) });
    // Drop empty rooms but keep their history briefly? For tonight, keep history
    // so a room that empties and refills still shows the mural. Memory is fine
    // for a handful of small rooms.
  });

  ws.on('error', () => { /* close handler does cleanup */ });
});

// ---- Saved artwork (per device key; account-ready) ------------------------
// Each device gets an anonymous user key (stored client-side). Artworks are
// persisted on disk keyed by that key, capped per user. This is the storage the
// future sign-in will adopt — swap the key for an authenticated user id.
const ARTWORK_DIR = process.env.ARTWORK_DIR || join(__dirname, '.artworks');
const MAX_SAVES = Number(process.env.MAX_SAVES || 12);

function sanitizeKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}
function userArtFile(key) {
  return join(ARTWORK_DIR, `${sanitizeKey(key)}.json`);
}
function loadUserArt(key) {
  try {
    const arr = JSON.parse(readFileSync(userArtFile(key), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveUserArt(key, arr) {
  mkdirSync(ARTWORK_DIR, { recursive: true });
  writeFileSync(userArtFile(key), JSON.stringify(arr));
}

app.use(express.json({ limit: '16mb' }));

app.get('/api/artworks', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = sanitizeKey(req.query.userKey);
  if (!key) {
    return res.json({ items: [], max: MAX_SAVES });
  }
  const items = loadUserArt(key).map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt, thumb: a.thumb }));
  res.json({ items, max: MAX_SAVES });
});

app.get('/api/artworks/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = sanitizeKey(req.query.userKey);
  const item = loadUserArt(key).find((a) => a.id === req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ id: item.id, name: item.name, image: item.image });
});

app.post('/api/artworks', (req, res) => {
  const { userKey, name, image, thumb } = req.body || {};
  const key = sanitizeKey(userKey);
  if (!key || typeof image !== 'string' || !image.startsWith('data:image')) {
    return res.status(400).json({ error: 'bad request' });
  }
  const arr = loadUserArt(key);
  if (arr.length >= MAX_SAVES) {
    return res.status(409).json({ error: 'limit', max: MAX_SAVES });
  }
  const item = {
    id: 'art_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: String(name || 'My drawing').slice(0, 60),
    createdAt: Date.now(),
    thumb: typeof thumb === 'string' ? thumb : '',
    image,
  };
  arr.unshift(item);
  saveUserArt(key, arr);
  res.json({ ok: true, id: item.id, count: arr.length, max: MAX_SAVES });
});

app.delete('/api/artworks/:id', (req, res) => {
  const key = sanitizeKey(req.query.userKey);
  const arr = loadUserArt(key);
  const next = arr.filter((a) => a.id !== req.params.id);
  saveUserArt(key, next);
  res.json({ ok: true, count: next.length, max: MAX_SAVES });
});

// ---- Admin + moderation ---------------------------------------------------
// Admin key: from env, else a persisted random key (printed on boot). The parent
// enters it once at /admin; it never ships in the client bundle.
const ADMIN_KEY_FILE = join(__dirname, '.admin-key');
let ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) {
  try { ADMIN_KEY = readFileSync(ADMIN_KEY_FILE, 'utf8').trim(); } catch { ADMIN_KEY = ''; }
}
if (!ADMIN_KEY) {
  ADMIN_KEY = randomBytes(12).toString('hex');
  try { writeFileSync(ADMIN_KEY_FILE, ADMIN_KEY); } catch { /* ignore */ }
}

const REPORTS_FILE = join(__dirname, '.reports.json');
let reports = [];
try {
  const parsed = JSON.parse(readFileSync(REPORTS_FILE, 'utf8'));
  reports = Array.isArray(parsed) ? parsed : [];
} catch {
  reports = [];
}
function persistReports() {
  try { writeFileSync(REPORTS_FILE, JSON.stringify(reports.slice(0, 500))); } catch { /* ignore */ }
}

function isAdmin(req) {
  const key = req.get('x-admin-key') || req.query.key;
  return Boolean(key) && key === ADMIN_KEY;
}
function adminGuard(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Anyone can file a report (no auth) — that's the point.
app.post('/api/report', (req, res) => {
  const { room, reason, reporterName } = req.body || {};
  if (!room) {
    return res.status(400).json({ error: 'room required' });
  }
  reports.unshift({
    id: 'rep_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    room: String(room).toUpperCase().slice(0, 16),
    reason: String(reason || '').slice(0, 300),
    reporterName: String(reporterName || 'anonymous').slice(0, 20),
    ts: Date.now(),
    status: 'open',
  });
  if (reports.length > 500) reports.length = 500;
  persistReports();
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json({ ok: true });
});

app.get('/api/admin/rooms', (req, res) => {
  if (!adminGuard(req, res)) return;
  const list = [];
  rooms.forEach((room, id) => list.push({ id, users: room.users.size, strokes: room.history.length, lastActivity: room.lastActivity || 0 }));
  list.sort((a, b) => b.users - a.users || b.lastActivity - a.lastActivity || b.strokes - a.strokes);
  res.json({ rooms: list, openReports: reports.filter((r) => r.status === 'open').length });
});

app.post('/api/admin/rooms/:id/clear', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = String(req.params.id).toUpperCase().slice(0, 16);
  const room = rooms.get(id);
  if (room) {
    room.lastCleared = room.history;
    room.history = [];
    broadcast(id, { type: 'clear', userId: 'admin', name: 'a moderator' });
    persistRoom(id);
  }
  res.json({ ok: true });
});

app.get('/api/admin/reports', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json({ reports });
});

app.post('/api/admin/reports/:id/resolve', (req, res) => {
  if (!adminGuard(req, res)) return;
  const report = reports.find((r) => r.id === req.params.id);
  if (report) {
    report.status = 'resolved';
    persistReports();
  }
  res.json({ ok: true });
});

// ---- Coloring sheets ------------------------------------------------------
// Admin uploads line-art images; anyone can list them and apply one to a room.
const SHEETS_FILE = join(__dirname, '.sheets.json');
let sheets = [];
try {
  const parsed = JSON.parse(readFileSync(SHEETS_FILE, 'utf8'));
  sheets = Array.isArray(parsed) ? parsed : [];
} catch {
  sheets = [];
}
function persistSheets() {
  try { writeFileSync(SHEETS_FILE, JSON.stringify(sheets)); } catch { /* ignore */ }
}

app.get('/api/sheets', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ sheets: sheets.map((s) => ({ id: s.id, name: s.name, thumb: s.thumb })) });
});

app.get('/api/sheets/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const sheet = sheets.find((s) => s.id === req.params.id);
  if (!sheet) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ id: sheet.id, name: sheet.name, image: sheet.image });
});

app.post('/api/admin/sheets', (req, res) => {
  if (!adminGuard(req, res)) return;
  const { name, image, thumb } = req.body || {};
  if (typeof image !== 'string' || !image.startsWith('data:image')) {
    return res.status(400).json({ error: 'image required' });
  }
  const item = {
    id: 'sheet_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || 'Coloring sheet').slice(0, 60),
    thumb: typeof thumb === 'string' ? thumb : '',
    image,
    createdAt: Date.now(),
  };
  sheets.unshift(item);
  if (sheets.length > 200) sheets.length = 200;
  persistSheets();
  res.json({ ok: true, id: item.id });
});

app.delete('/api/admin/sheets/:id', (req, res) => {
  if (!adminGuard(req, res)) return;
  sheets = sheets.filter((s) => s.id !== req.params.id);
  persistSheets();
  res.json({ ok: true });
});

// ---- Live metrics (admin) -------------------------------------------------
const serverStart = Date.now();
app.get('/api/admin/metrics', (req, res) => {
  if (!adminGuard(req, res)) return;
  const now = Date.now();
  const ACTIVE_MS = 60000; // drew/moved/chatted within the last minute = "active"
  let totalUsers = 0;
  let active = 0;
  let totalStrokes = 0;
  rooms.forEach((room) => {
    totalStrokes += room.history.length;
    room.users.forEach((u) => {
      totalUsers += 1;
      if (now - (u.lastActivity || 0) < ACTIVE_MS) active += 1;
    });
  });
  const mem = process.memoryUsage();
  const mb = (b) => Math.round((b / 1048576) * 10) / 10;

  // CPU% since the previous poll: cpu-microseconds used / wall-microseconds
  // elapsed. ~100 means one core fully pinned. Node is mostly single-threaded
  // so anything sustained above ~80 means the box is the bottleneck.
  const cpuDelta = process.cpuUsage(lastCpu);
  const wallMs = Math.max(1, now - lastCpuAt);
  const cpuPct = Math.round(((cpuDelta.user + cpuDelta.system) / 1000 / wallMs) * 100 * 10) / 10;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;

  // Event-loop lag since the previous poll (the clearest "server straining"
  // signal — high lag = laggy drawing for everyone). We subtract the learned OS
  // timer floor so this reads ~0 when healthy. Reset so each poll is fresh.
  const rawMinMs = eld.min / 1e6;
  if (Number.isFinite(rawMinMs) && rawMinMs >= 0.1 && rawMinMs < 5000) {
    loopFloorMs = Math.min(loopFloorMs, rawMinMs);
  }
  const floor = Number.isFinite(loopFloorMs) ? loopFloorMs : ELD_RESOLUTION_MS;
  const lag = (ns) => {
    const v = ns / 1e6;
    return Number.isFinite(v) && v > floor ? Math.round((v - floor) * 10) / 10 : 0;
  };
  const loop = {
    meanMs: lag(eld.mean),
    p99Ms: lag(eld.percentile(99)),
    maxMs: lag(eld.max),
    baselineMs: Math.round(floor * 10) / 10,
  };
  eld.reset();

  res.json({
    uptimeSec: Math.round((now - serverStart) / 1000),
    node: process.version,
    pid: process.pid,
    memory: {
      rssMB: mb(mem.rss),
      heapUsedMB: mb(mem.heapUsed),
      heapTotalMB: mb(mem.heapTotal),
      externalMB: mb(mem.external),
    },
    connections: wss.clients.size,
    users: { total: totalUsers, active, inactive: totalUsers - active },
    peakUsers,
    peakAt,
    cpuPct,
    loopLag: loop,
    rooms: rooms.size,
    strokes: totalStrokes,
    reports: { open: reports.filter((r) => r.status === 'open').length, total: reports.length },
    sheets: sheets.length,
  });
});

// ---- Static host ----------------------------------------------------------
app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

const distPath = join(__dirname, 'dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  // SPA fallback (Express 5: use middleware, not an app.get('*') route). Every
  // unmatched GET returns index.html so /studio, /join/CODE and /admin work on
  // direct load / refresh.
  app.use((req, res) => {
    if (req.method !== 'GET') {
      res.status(404).end();
      return;
    }
    res.sendFile(join(distPath, 'index.html'));
  });
} else {
  app.use((_req, res) => res.status(503).send('Build missing. Run `npm run build` first.'));
}

server.listen(PORT, () => {
  console.log(`Happy Paint server on http://localhost:${PORT}  (ws path /ws)`);
  console.log(`Admin key for /admin (also in .admin-key): ${ADMIN_KEY}`);
});

function shutdown() {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
