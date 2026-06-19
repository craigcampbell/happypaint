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

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { users: new Map(), history: [], lastCleared: null });
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
  const user = { id, name, color, ws };
  room.users.set(id, user);
  ws.roomId = roomId;
  ws.userId = id;

  ws.send(JSON.stringify({ type: 'connected', userId: id, userName: name, userColor: color, roomId }));
  ws.send(JSON.stringify({ type: 'userList', users: userListOf(room) }));
  if (room.history.length > 0) {
    ws.send(JSON.stringify({ type: 'history', ops: room.history }));
  }
  broadcast(roomId, { type: 'userJoined', user: { id, name, color }, userList: userListOf(room) }, id);

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

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
        break;
      }
      case 'cursor':
        broadcast(roomId, {
          type: 'cursor', userId: id, name: user.name, color: user.color,
          x: data.x, y: data.y, drawing: !!data.drawing,
        }, id);
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
        broadcast(roomId, { type: 'clear', userId: id, name }, id);
        break;
      case 'undo_clear':
        // Restore the most recently cleared mural for the whole room.
        if (room.lastCleared && room.lastCleared.length) {
          room.history = room.lastCleared;
          room.lastCleared = null;
          broadcast(roomId, { type: 'history', ops: room.history, restored: true });
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
});

function shutdown() {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
