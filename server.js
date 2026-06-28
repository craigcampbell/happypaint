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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs';
import { randomBytes } from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';
import { verifyAccessToken } from './server/pocketbaseAuth.js';
import { scan } from './server/moderation/textFilter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Minimal .env loader (no dependency) so the same repo-root .env that Vite reads
// at build time also configures the server at runtime — e.g. SUPABASE_URL /
// SUPABASE_ANON_KEY for sign-in identity. Only fills vars not already set in the
// real process environment, so launch-env always wins.
(function loadDotEnv() {
  try {
    const txt = readFileSync(join(__dirname, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {
    // No .env file — perfectly fine; the app runs fully local/anonymous.
  }
})();

const PORT = Number(process.env.PORT || 8787);
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 6000);
const MAX_ROOM_USERS = Number(process.env.MAX_ROOM_USERS || 30);
const KICK_BAN_MS = Number(process.env.KICK_BAN_MS || 15 * 60 * 1000); // how long a kicked signed-in user is blocked from rejoining
const MAX_WATCHERS = Number(process.env.MAX_WATCHERS || 2); // elected in-browser NSFW watchers per public room
const WATCH_INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS || 8000); // min ms between watcher samples
const WATCH_MAX_DIM = Number(process.env.WATCH_MAX_DIM || 256); // longest snapshot edge the watcher downscales to
const FLAG_WINDOW_MS = Number(process.env.FLAG_WINDOW_MS || 30_000); // corroboration window for moderation flags

// Auto-close idle rooms. The allowed idle time scales with the room's complexity
// (op count) and engagement (cumulative user-seconds), so a rich, well-loved mural
// lingers far longer than a quick scribble before it's cleaned up. MAIN never closes.
const AUTO_CLOSE_ENABLED = process.env.AUTO_CLOSE !== 'off';
const AUTO_CLOSE_BASE_MS = Number(process.env.AUTO_CLOSE_BASE_MS || 12 * 60 * 60 * 1000); // 12h idle floor
const AUTO_CLOSE_MAX_MS = Number(process.env.AUTO_CLOSE_MAX_MS || 30 * 24 * 60 * 60 * 1000); // 30d ceiling
const AUTO_CLOSE_PER_OP_MS = Number(process.env.AUTO_CLOSE_PER_OP_MS || 20 * 1000); // +20s of life per op drawn
const AUTO_CLOSE_PER_USER_SEC_MS = Number(process.env.AUTO_CLOSE_PER_USER_SEC_MS || 2000); // +2s of life per user-second
const AUTO_CLOSE_SWEEP_MS = Number(process.env.AUTO_CLOSE_SWEEP_MS || 30 * 60 * 1000); // sweep cadence

// All durable server state (rooms, artworks, sheets, reports, admin key, metrics)
// lives under one directory so a single Docker volume persists everything. Defaults
// to the app dir, so non-Docker runs behave exactly as before.
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }

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

const METRICS_FILE = join(DATA_DIR, '.metrics.json');
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
const ROOM_DIR = process.env.ROOM_DIR || join(DATA_DIR, '.rooms');
const persistTimers = new Map();
function roomFile(roomId) {
  return join(ROOM_DIR, `${String(roomId).replace(/[^A-Z0-9_-]/gi, '').slice(0, 32)}.json`);
}
function loadRoom(roomId) {
  try {
    const data = JSON.parse(readFileSync(roomFile(roomId), 'utf8'));
    return {
      history: Array.isArray(data.history) ? data.history : [],
      sheetId: data.sheetId || null,
      // Only the opaque profile id is persisted — never a human-readable name —
      // so a deleted account leaves no identifying data on disk. Display names
      // come live from the connected roster.
      ownerProfileId: data.ownerProfileId || null,
      coHosts: Array.isArray(data.coHosts) ? data.coHosts : [],
      mutedProfileIds: Array.isArray(data.mutedProfileIds) ? data.mutedProfileIds : [],
      locked: !!data.locked,
      title: typeof data.title === 'string' ? data.title : null,
      // Audience gate + discovery flag + moderation-hidden op ids. Null audience
      // means "not yet decided" — getRoom applies a per-room default.
      audience: typeof data.audience === 'string' ? data.audience : null,
      listed: typeof data.listed === 'boolean' ? data.listed : null,
      hiddenOpIds: Array.isArray(data.hiddenOpIds) ? data.hiddenOpIds : [],
      userSeconds: Number(data.userSeconds) || 0,
    };
  } catch {
    return { history: [], sheetId: null, ownerProfileId: null, coHosts: [], mutedProfileIds: [], locked: false, title: null, audience: null, listed: null, hiddenOpIds: [], userSeconds: 0 };
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
      // Note: room.lastCleared is intentionally in-memory only — never persisted.
      writeFileSync(roomFile(roomId), JSON.stringify({
        history: room.history,
        sheetId: room.sheetId || null,
        ownerProfileId: room.ownerProfileId || null,
        coHosts: Array.isArray(room.coHosts) ? room.coHosts : [],
        mutedProfileIds: Array.from(room.mutedProfileIds || []),
        locked: !!room.locked,
        title: room.title || null,
        audience: room.audience || null,
        listed: typeof room.listed === 'boolean' ? room.listed : null,
        hiddenOpIds: Array.from(room.hiddenOpIds || []),
        userSeconds: room.userSeconds || 0,
        savedAt: Date.now(),
      }));
    } catch {
      // Non-fatal — persistence is best-effort.
    }
  }, 2500));
}

// The one legacy room that is public by default; everything else reached by an
// invite code is a private ("friends") room unless explicitly created public.
const DEFAULT_PUBLIC_ROOM = 'MAIN';

// Always-open, always-listed public "prompt rooms" that anchor the lobby so it
// never looks empty: each is a kid-safe themed room anyone can drop into, shown
// in /api/rooms/public even at 0 users and never auto-closed (like MAIN). Each
// carries a small pool of kid-friendly prompts; the one shown rotates daily so
// the lobby feels fresh. Codes MUST be <=8 uppercase-alnum chars (the /join path
// normalizer uppercases + strips + slices to 8).
const FEATURED_ROOMS = [
  { code: 'MAIN', title: 'Open Studio', emoji: '🎨', prompts: ['Draw anything you like!', 'Free draw — make something awesome', 'Your canvas, your rules'] },
  { code: 'DOODLE', title: 'Doodle Jam', emoji: '✏️', prompts: ['Fill the page with doodles', 'Squiggles, swirls & shapes', 'One big group scribble'] },
  { code: 'DINOS', title: 'Dino World', emoji: '🦕', prompts: ['Draw your wildest dinosaur', 'A dino having a picnic', 'T-rex vs triceratops!'] },
  { code: 'SPACE', title: 'Outer Space', emoji: '🚀', prompts: ['Rockets, planets & friendly aliens', 'Build a space station', 'Your own little galaxy'] },
  { code: 'OCEAN', title: 'Under the Sea', emoji: '🐙', prompts: ['Fish, mermaids & sea monsters', 'A coral reef party', 'Deep-sea treasure hunt'] },
  { code: 'PETS', title: 'Pet Parade', emoji: '🐶', prompts: ['Draw the cutest pet', 'A puppy and a kitten', 'Your dream pet'] },
  { code: 'RAINBOW', title: 'Rainbow Lab', emoji: '🌈', prompts: ['Make the brightest rainbow', 'An explosion of color', 'Rainbow everything!'] },
  { code: 'CASTLE', title: 'Castles & Dragons', emoji: '🏰', prompts: ['Knights, castles & dragons', 'A magic kingdom', 'Build the tallest tower'] },
];
const FEATURED_CODES = new Set(FEATURED_ROOMS.map((r) => r.code));
const FEATURED_INDEX = new Map(FEATURED_ROOMS.map((r, i) => [r.code, i]));

// The prompt shown today for a featured room (deterministic daily rotation, UTC).
function dailyPromptFor(featured) {
  if (!featured || !featured.prompts || !featured.prompts.length) return null;
  const day = Math.floor(Date.now() / 86400000);
  return featured.prompts[day % featured.prompts.length];
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const saved = loadRoom(roomId);
    // Audience default: the legacy MAIN room is the public hall (kid_safe); a
    // room first reached by an invite code is private (friends). A room created
    // via POST /api/rooms persists its audience, which wins here.
    const audience = saved.audience || (roomId === DEFAULT_PUBLIC_ROOM ? 'kid_safe' : 'friends');
    const listed = saved.listed != null ? saved.listed : audience === 'kid_safe';
    // Recover the op-id counter from persisted history so ids stay monotonic
    // across restarts (selective moderation hides/restores by opId).
    let opSeq = 0;
    for (const op of saved.history) {
      if (op && typeof op.opId === 'number' && op.opId > opSeq) opSeq = op.opId;
    }
    rooms.set(roomId, {
      code: roomId,
      users: new Map(),
      history: saved.history,
      lastCleared: null,
      sheetId: saved.sheetId,
      ownerProfileId: saved.ownerProfileId,
      coHosts: saved.coHosts,
      mutedProfileIds: new Set(saved.mutedProfileIds),
      kickedProfiles: new Map(), // profileId -> expiry ts; in-memory short ban
      locked: saved.locked,
      title: saved.title,
      audience,
      listed,
      opSeq,
      hiddenOpIds: new Set(saved.hiddenOpIds), // moderation: reversibly hidden ops
      flags: [], // recent moderation flags (in-memory, for corroboration)
      flaggedOps: new Set(), // op ids already alerted on (avoids duplicate Tier-1 alerts)
      watchers: new Set(), // elected client ids running the in-browser watcher
      modLog: [], // recent moderation actions (in-memory, capped)
      userSeconds: saved.userSeconds || 0, // cumulative engagement, for auto-close TTL
      lastActivity: Date.now(),
    });
  }
  return rooms.get(roomId);
}

// Materialize the featured prompt rooms so they always exist, stay kid_safe +
// listed, and carry their canonical title. Re-applied every boot so they can't
// drift; they're exempt from the idle auto-close sweep below.
function seedFeaturedRooms() {
  for (const f of FEATURED_ROOMS) {
    const room = getRoom(f.code);
    room.audience = 'kid_safe';
    room.listed = true;
    room.title = f.title;
  }
}
seedFeaturedRooms();

// The op history minus moderation-hidden ops — what late joiners and post-hide
// rebuilds actually receive. Cheap no-op when nothing is hidden (the common case).
function visibleHistory(room) {
  if (!room.hiddenOpIds || room.hiddenOpIds.size === 0) return room.history;
  return room.history.filter((op) => !room.hiddenOpIds.has(op.opId));
}

// Allowed idle time before an EMPTY room is auto-closed. Scales with complexity
// (op count) and engagement (cumulative user-seconds), capped — so a rich, busy
// mural lingers much longer than a quick scribble. Works on a live room or a
// plain {history,userSeconds} read from disk.
function allowedIdleMs(room) {
  const ops = Array.isArray(room.history) ? room.history.length : 0;
  const userSeconds = room.userSeconds || 0;
  const bonus = ops * AUTO_CLOSE_PER_OP_MS + userSeconds * AUTO_CLOSE_PER_USER_SEC_MS;
  return Math.min(AUTO_CLOSE_MAX_MS, AUTO_CLOSE_BASE_MS + bonus);
}

// Tear a room down: disconnect anyone in it, drop it from memory, delete its file.
// Used by the admin "delete room" action and the idle auto-close sweep.
function closeRoom(roomId, reason) {
  const room = rooms.get(roomId);
  if (room) {
    room.users.forEach((u) => {
      try {
        if (u.ws.readyState === 1) {
          u.ws.send(JSON.stringify({ type: 'room_closed', reason: reason || 'closed' }));
          u.ws.close(1000, 'room closed');
        }
      } catch { /* ignore */ }
    });
    const t = persistTimers.get(roomId);
    if (t) { clearTimeout(t); persistTimers.delete(roomId); }
    rooms.delete(roomId);
  }
  try { unlinkSync(roomFile(roomId)); } catch { /* no file / already gone */ }
}

// Periodic cleanup of idle rooms: in-memory empties + abandoned files on disk.
// MAIN is never closed; disable entirely with AUTO_CLOSE=off.
function autoCloseSweep() {
  const now = Date.now();
  rooms.forEach((room, id) => {
    if (FEATURED_CODES.has(id) || room.users.size > 0) return;
    if (now - (room.lastActivity || now) > allowedIdleMs(room)) {
      closeRoom(id, 'inactive');
    }
  });
  let files = [];
  try { files = readdirSync(ROOM_DIR).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    if (FEATURED_CODES.has(id) || rooms.has(id)) continue;
    try {
      const data = JSON.parse(readFileSync(join(ROOM_DIR, f), 'utf8'));
      const pseudo = { history: data.history || [], userSeconds: Number(data.userSeconds) || 0 };
      if (now - (data.savedAt || 0) > allowedIdleMs(pseudo)) {
        unlinkSync(join(ROOM_DIR, f));
      }
    } catch { /* ignore unreadable file */ }
  }
}
if (AUTO_CLOSE_ENABLED) {
  const sweepTimer = setInterval(autoCloseSweep, AUTO_CLOSE_SWEEP_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

// Op ids in the (sinceOpId, toOpId] window — the "delta that turned the canvas
// lewd" that an image flag implicates.
function opIdsInRange(room, sinceOpId, toOpId) {
  const ids = [];
  for (const op of room.history) {
    if (op.opId > sinceOpId && op.opId <= toOpId) ids.push(op.opId);
  }
  return ids;
}

// Elect up to MAX_WATCHERS capable clients to run the in-browser NSFW watcher in
// a public room (prefer signed-in, then earliest joined). Only the elected few
// scan, so the cost never multiplies across everyone painting. Idempotent — only
// emits watcher_role when a client's status actually changes.
function electWatchers(room) {
  if (!room) return;
  for (const wid of Array.from(room.watchers)) {
    if (!room.users.has(wid)) room.watchers.delete(wid);
  }
  if (room.audience !== 'kid_safe') {
    room.watchers.forEach((wid) => {
      const u = room.users.get(wid);
      if (u && u.ws.readyState === 1) u.ws.send(JSON.stringify({ type: 'watcher_role', active: false }));
    });
    room.watchers.clear();
    return;
  }
  const candidates = Array.from(room.users.values()).filter((u) => u.watcherCapable);
  candidates.sort((a, b) => (Number(Boolean(b.profileId)) - Number(Boolean(a.profileId))) || (a.connectedAt - b.connectedAt));
  const chosen = new Set(candidates.slice(0, MAX_WATCHERS).map((u) => u.id));
  room.users.forEach((u) => {
    const isWatcher = room.watchers.has(u.id);
    if (chosen.has(u.id) && !isWatcher) {
      room.watchers.add(u.id);
      if (u.ws.readyState === 1) {
        u.ws.send(JSON.stringify({ type: 'watcher_role', active: true, intervalMs: WATCH_INTERVAL_MS, maxDim: WATCH_MAX_DIM }));
      }
    } else if (!chosen.has(u.id) && isWatcher) {
      room.watchers.delete(u.id);
      if (u.ws.readyState === 1) u.ws.send(JSON.stringify({ type: 'watcher_role', active: false }));
    }
  });
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

// A user hosts a room if they're the owner (the first signed-in grown-up to
// claim it) or a promoted co-host. Anonymous users (no profileId) never host.
function isHost(room, user) {
  if (!user || !user.profileId) return false;
  return user.profileId === room.ownerProfileId || (room.coHosts || []).includes(user.profileId);
}

function userListOf(room) {
  return Array.from(room.users.values()).map((u) => ({
    id: u.id,
    name: u.name,
    color: u.color,
    signedIn: Boolean(u.profileId),
    isOwner: Boolean(u.profileId && u.profileId === room.ownerProfileId),
    isHost: isHost(room, u),
    muted: !!u.muted,
  }));
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

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get('room') || 'MAIN').toUpperCase().slice(0, 16);
  const room = getRoom(roomId);

  // adult_18 is a defined-but-disabled audience: real adult verification doesn't
  // exist in this stack, so no normal user can create one (POST /api/rooms 403s)
  // and nobody can join one. The gate exists so the model is complete + safe.
  if (room.audience === 'adult_18') {
    ws.send(JSON.stringify({ type: 'room_blocked', reason: 'adult_disabled' }));
    ws.close(1008, 'adult disabled');
    return;
  }

  if (room.users.size >= MAX_ROOM_USERS) {
    ws.send(JSON.stringify({ type: 'room_full', max: MAX_ROOM_USERS }));
    ws.close(1008, 'room full');
    return;
  }

  // Optional identity. A signed-in user passes their Supabase access token; we
  // validate it with the public anon key (no secrets) and learn their profile.
  // Anonymous users pass nothing and stay anonymous — sign-in only unlocks
  // ownership/host powers, never the ability to draw.
  const token = url.searchParams.get('token');
  const identity = token ? await verifyAccessToken(token) : null;
  if (ws.readyState !== 1) return; // user disconnected during validation

  // Honor a recent host kick (signed-in users only; short in-memory ban). A
  // kicked anonymous user can't be reliably blocked behind the tunnel, but the
  // client tears its own socket down so it won't silently auto-rejoin.
  if (identity && room.kickedProfiles.size) {
    const expiry = room.kickedProfiles.get(identity.profileId);
    if (expiry && expiry > Date.now()) {
      ws.send(JSON.stringify({ type: 'kicked', by: 'a host' }));
      ws.close(1008, 'kicked');
      return;
    }
    if (expiry) room.kickedProfiles.delete(identity.profileId);
  }

  const id = nextUserId();
  const name = (identity && identity.displayName) || pick(ANIMAL_NAMES);
  const color = pick(USER_COLORS);
  const user = {
    id,
    name,
    color,
    ws,
    profileId: identity ? identity.profileId : null,
    verified: Boolean(identity),
    // Mute follows the signed-in identity across reconnects (anonymous = per-session).
    muted: identity ? room.mutedProfileIds.has(identity.profileId) : false,
    connectedAt: Date.now(),
    lastActivity: Date.now(),
  };
  room.users.set(id, user);
  room.lastActivity = Date.now();
  notePeak();
  ws.roomId = roomId;
  ws.userId = id;

  // First signed-in grown-up to enter an unowned room claims & hosts it.
  // Guard on still-unowned so two simultaneous joiners can't both claim.
  if (user.profileId && !room.ownerProfileId) {
    room.ownerProfileId = user.profileId;
    persistRoom(roomId);
  }

  ws.send(JSON.stringify({
    type: 'connected',
    userId: id,
    userName: name,
    userColor: color,
    roomId,
    profileId: user.profileId,
    isOwner: Boolean(user.profileId && user.profileId === room.ownerProfileId),
    isHost: isHost(room, user),
    locked: !!room.locked,
    muted: !!user.muted,
    roomTitle: room.title || null,
    audience: room.audience,
  }));
  ws.send(JSON.stringify({ type: 'userList', users: userListOf(room) }));
  // Always sync a history frame for any room that has ever had ops, so a joiner
  // sees the exact current (post-moderation) mural — even when everything visible
  // was just hidden. Truly-empty rooms still send nothing.
  if (room.history.length > 0) {
    ws.send(JSON.stringify({ type: 'history', ops: visibleHistory(room) }));
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
        // When a host locks the room, only hosts may keep drawing. This is the
        // real boundary — clients also disable the canvas, but this enforces it.
        if (room.locked && !isHost(room, user)) break;
        // Public-room text moderation: block severe drawn text before it lands on
        // the shared mural. Imagery is handled by the watcher/flag path. O(small),
        // synchronous — adds no latency to the normal draw-op relay below.
        if (room.audience === 'kid_safe' && data.op.kind === 'text' && typeof data.op.text === 'string') {
          const verdict = scan(data.op.text);
          if (verdict.severity === 'severe') {
            autoModerate(room, user, `drawn text: ${verdict.terms.join(', ')}`);
            break;
          }
        }
        // Tag with the author so replay/cursors can attribute it, plus a stable
        // monotonic opId so moderation can hide/restore individual ops later.
        const op = { ...data.op, userId: id, opId: (room.opSeq = (room.opSeq || 0) + 1) };
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
        // Setting the shared coloring sheet is a host decision once the room is
        // owned. Legacy unowned rooms stay open so existing behavior is unchanged.
        if (room.ownerProfileId && !isHost(room, user)) break;
        // Set (or clear) the room's coloring sheet for everyone.
        room.sheetId = data.sheetId ? String(data.sheetId).slice(0, 200) : null;
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
        // In an owned room only a host may wipe the shared mural; unowned public
        // rooms keep the original free-for-all behavior.
        if (room.ownerProfileId && !isHost(room, user)) break;
        // Keep a backup so the room can undo a clear (everyone gets mad otherwise).
        room.lastCleared = room.history;
        room.history = [];
        broadcast(roomId, { type: 'clear', userId: id, name: user.name }, id);
        persistRoom(roomId);
        break;
      case 'undo_clear':
        if (room.ownerProfileId && !isHost(room, user)) break;
        // Restore the most recently cleared mural for the whole room.
        if (room.lastCleared && room.lastCleared.length) {
          room.history = room.lastCleared;
          room.lastCleared = null;
          broadcast(roomId, { type: 'history', ops: room.history, restored: true });
          persistRoom(roomId);
        }
        break;
      case 'chat': {
        if (user.muted) break; // a host muted this user
        if (typeof data.message !== 'string' || !data.message.trim()) break;
        let message = String(data.message).slice(0, 300);
        // Public-room chat moderation: drop severe messages (and alert hosts),
        // soft-mask milder profanity. Private rooms are unfiltered.
        if (room.audience === 'kid_safe') {
          const verdict = scan(message);
          if (verdict.severity === 'severe') {
            autoModerate(room, user, `chat: ${verdict.terms.join(', ')}`);
            if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'chat_blocked' }));
            break;
          }
          if (verdict.hit) message = maskMessage(message);
        }
        broadcast(roomId, {
          type: 'chat', user: { id, name: user.name, color: user.color },
          message, ts: Date.now(),
        });
        break;
      }

      // ---- Host-only room controls (require a verified host) ----------------
      case 'lock':
      case 'unlock': {
        if (!isHost(room, user)) break;
        room.locked = data.type === 'lock';
        broadcast(roomId, { type: 'room_state', locked: room.locked, by: user.name });
        persistRoom(roomId);
        break;
      }
      case 'rename_room': {
        if (!isHost(room, user)) break;
        const title = typeof data.name === 'string' ? data.name.trim().slice(0, 40) : '';
        room.title = title || null;
        broadcast(roomId, { type: 'room_renamed', title: room.title });
        persistRoom(roomId);
        break;
      }
      case 'mute': {
        if (!isHost(room, user)) break;
        const target = room.users.get(data.targetId);
        if (target && !isHost(room, target)) {
          target.muted = data.muted !== false;
          // Bind the mute to the signed-in identity so it survives a reconnect.
          if (target.profileId) {
            if (target.muted) room.mutedProfileIds.add(target.profileId);
            else room.mutedProfileIds.delete(target.profileId);
            persistRoom(roomId);
          }
          if (target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({ type: 'muted', muted: target.muted }));
          }
          broadcast(roomId, { type: 'userList', users: userListOf(room) });
        }
        break;
      }
      case 'kick': {
        if (!isHost(room, user)) break;
        const target = room.users.get(data.targetId);
        if (target && target.id !== id && !isHost(room, target)) {
          // Short ban so a signed-in kicked user can't immediately reconnect.
          if (target.profileId) {
            room.kickedProfiles.set(target.profileId, Date.now() + KICK_BAN_MS);
          }
          if (target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({ type: 'kicked', by: user.name }));
            target.ws.close(1008, 'kicked');
          }
          // close handler removes them + broadcasts userLeft
        }
        break;
      }
      case 'promote':
      case 'demote': {
        // Only the room owner can hand out / take back co-host.
        if (!user.profileId || user.profileId !== room.ownerProfileId) break;
        const target = room.users.get(data.targetId);
        if (!target || !target.profileId || target.profileId === room.ownerProfileId) break;
        const set = new Set(room.coHosts || []);
        if (data.type === 'promote') set.add(target.profileId);
        else set.delete(target.profileId);
        room.coHosts = Array.from(set);
        if (target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ type: 'role_changed', isHost: isHost(room, target) }));
        }
        broadcast(roomId, { type: 'userList', users: userListOf(room) });
        persistRoom(roomId);
        break;
      }

      // ---- Moderation: reversible hide / restore / permanent remove --------
      // Operate on stable op ids. Hiding is reversible (op stays in history but
      // is filtered out of replay); removing is permanent. Reuses the existing
      // `history` rebuild on clients, so no extra client canvas logic is needed.
      case 'mod_hide': {
        if (!isHost(room, user)) break;
        const ids = Array.isArray(data.opIds) ? data.opIds : [];
        if (!ids.length) break;
        ids.forEach((opId) => room.hiddenOpIds.add(opId));
        broadcast(roomId, { type: 'history', ops: visibleHistory(room) });
        persistRoom(roomId);
        break;
      }
      case 'mod_restore': {
        if (!isHost(room, user)) break;
        const ids = Array.isArray(data.opIds) ? data.opIds : [];
        if (!ids.length) break;
        ids.forEach((opId) => room.hiddenOpIds.delete(opId));
        broadcast(roomId, { type: 'history', ops: visibleHistory(room), restored: true });
        persistRoom(roomId);
        break;
      }
      case 'mod_remove': {
        if (!isHost(room, user)) break;
        const ids = new Set(Array.isArray(data.opIds) ? data.opIds : []);
        if (!ids.size) break;
        room.history = room.history.filter((op) => !ids.has(op.opId));
        ids.forEach((opId) => room.hiddenOpIds.delete(opId));
        broadcast(roomId, { type: 'history', ops: visibleHistory(room) });
        persistRoom(roomId);
        break;
      }

      // ---- Image moderation: watcher election + flag corroboration ---------
      case 'watcher_ack': {
        // A client self-reports whether it can run the in-browser watcher; the
        // server decides who actually scans (election keeps it to a capable few).
        user.watcherCapable = data.capable !== false;
        electWatchers(room);
        break;
      }
      case 'flag': {
        // A watcher (or any client) flags a region as possibly lewd. Acted on
        // only in public rooms. Conservative ladder: a lone flag is Tier-1 (alert
        // the hosts, destroy nothing); corroboration is required before the
        // reversible auto-hide; a kick is NEVER automatic.
        if (room.audience !== 'kid_safe') break;
        const kind = data.kind === 'text' ? 'text' : 'image';
        const score = Number(data.score) || 0;
        const sinceOpId = Math.max(0, Number(data.sinceOpId) || 0);
        const toOpId = Number(data.toOpId) || 0;
        if (toOpId <= sinceOpId) break;
        const now = Date.now();
        room.flags = room.flags.filter((f) => now - f.ts < FLAG_WINDOW_MS);
        room.flags.push({ clientId: id, kind, sinceOpId, toOpId, ts: now });

        const implicated = opIdsInRange(room, sinceOpId, toOpId);
        if (!implicated.length) break;
        const culpritOp = room.history.find((op) => implicated.includes(op.opId));
        const offender = culpritOp ? room.users.get(culpritOp.userId) : null;

        // Tier 1: alert hosts once per implicated op (non-destructive).
        const firstAlert = implicated.some((opId) => !room.flaggedOps.has(opId));
        implicated.forEach((opId) => room.flaggedOps.add(opId));
        if (firstAlert) {
          autoModerate(room, offender, `possible lewd image (score ${score.toFixed(2)})`, implicated);
        }

        // Tier 2: corroborated (>=2 independent flaggers, or 1 flag + 1 human
        // report) -> reversible auto-hide of the implicated ops + mute author.
        const overlapping = room.flags.filter((f) => f.kind === kind && f.sinceOpId < toOpId && sinceOpId < f.toOpId);
        const flaggers = new Set(overlapping.map((f) => f.clientId));
        const humanReports = reports.filter(
          (r) => r.room === roomId && r.source === 'user' && r.status === 'open' && now - r.ts < FLAG_WINDOW_MS,
        ).length;
        const corroborated = flaggers.size >= 2 || (flaggers.size >= 1 && humanReports >= 1);
        if (corroborated) {
          const toHide = implicated.filter((opId) => !room.hiddenOpIds.has(opId));
          if (toHide.length) {
            toHide.forEach((opId) => room.hiddenOpIds.add(opId));
            const authorIds = new Set(room.history.filter((op) => toHide.includes(op.opId)).map((op) => op.userId));
            authorIds.forEach((uid) => { const au = room.users.get(uid); if (au) au.muted = true; });
            broadcast(roomId, { type: 'history', ops: visibleHistory(room) });
            alertHosts(room, {
              level: 'warn', reason: 'auto-hidden pending review', opIds: toHide,
              author: offender ? offender.name : null, source: 'auto', hidden: true,
            });
            persistRoom(roomId);
          }
        }
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    // Accrue this user's time in the room — engagement extends the auto-close TTL.
    room.userSeconds = (room.userSeconds || 0) + Math.max(0, (Date.now() - user.connectedAt) / 1000);
    room.users.delete(id);
    broadcast(roomId, { type: 'cursor_leave', userId: id });
    broadcast(roomId, { type: 'userLeft', userId: id, userList: userListOf(room) });
    persistRoom(roomId); // persist engagement once they leave
    // If a watcher left, promote another capable client so coverage continues.
    if (room.watchers.has(id) || room.watchers.size < MAX_WATCHERS) {
      room.watchers.delete(id);
      electWatchers(room);
    }
    // Never leave a room locked with no host present — otherwise an owner who
    // leaves (or deletes their account) could brick the canvas for everyone.
    if (room.locked && !Array.from(room.users.values()).some((u) => isHost(room, u))) {
      room.locked = false;
      broadcast(roomId, { type: 'room_state', locked: false, by: 'auto' });
      persistRoom(roomId);
    }
    // Keep history so a room that empties and refills still shows the mural.
  });

  ws.on('error', () => { /* close handler does cleanup */ });
});

// ---- Saved artwork (per device key; account-ready) ------------------------
// Each device gets an anonymous user key (stored client-side). Artworks are
// persisted on disk keyed by that key, capped per user. This is the storage the
// future sign-in will adopt — swap the key for an authenticated user id.
const ARTWORK_DIR = process.env.ARTWORK_DIR || join(DATA_DIR, '.artworks');
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
const ADMIN_KEY_FILE = join(DATA_DIR, '.admin-key');
let ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) {
  try { ADMIN_KEY = readFileSync(ADMIN_KEY_FILE, 'utf8').trim(); } catch { ADMIN_KEY = ''; }
}
if (!ADMIN_KEY) {
  ADMIN_KEY = randomBytes(12).toString('hex');
  try { writeFileSync(ADMIN_KEY_FILE, ADMIN_KEY); } catch { /* ignore */ }
}

const REPORTS_FILE = join(DATA_DIR, '.reports.json');
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

// Single entry point for the reports store so both human reports (/api/report)
// and auto-moderation share one shape. `source` distinguishes them in /admin.
function fileReport({ room, reason, reporterName, source }) {
  const report = {
    id: 'rep_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    room: String(room || '').toUpperCase().slice(0, 16),
    reason: String(reason || '').slice(0, 300),
    reporterName: String(reporterName || 'anonymous').slice(0, 20),
    source: source === 'auto' ? 'auto' : 'user',
    ts: Date.now(),
    status: 'open',
  };
  reports.unshift(report);
  if (reports.length > 500) reports.length = 500;
  persistReports();
  return report;
}

// Notify just the room's hosts (and nobody else) about a moderation event — a
// host/admin decides whether to hide/restore/remove. Never broadcast to kids.
function alertHosts(room, payload) {
  room.users.forEach((u) => {
    if (isHost(room, u) && u.ws.readyState === 1) {
      u.ws.send(JSON.stringify({ type: 'mod_alert', ...payload }));
    }
  });
}

// Tier-1 auto action (non-destructive): file an auto-report + alert the hosts +
// jot it in the room's moderation log. Used by the text filter and the image
// flag path. Destructive actions (hide/kick) stay a human decision.
function autoModerate(room, offender, reason, opIds) {
  fileReport({ room: room.code, reason: `auto: ${reason}`, reporterName: 'auto-mod', source: 'auto' });
  alertHosts(room, { level: 'warn', reason, author: offender ? offender.name : null, opIds: opIds || null, source: 'auto' });
  room.modLog.unshift({ ts: Date.now(), reason, author: offender ? offender.profileId : null });
  if (room.modLog.length > 100) room.modLog.length = 100;
}

// Mask individual profane tokens (mild hits) while leaving the rest readable.
function maskMessage(message) {
  return message
    .split(/(\s+)/)
    .map((tok) => (/^\s+$/.test(tok) ? tok : scan(tok).hit ? '*'.repeat(Math.max(3, tok.length)) : tok))
    .join('');
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
  fileReport({ room, reason, reporterName, source: 'user' });
  res.json({ ok: true });
});

app.get('/api/admin/check', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json({ ok: true });
});

app.get('/api/admin/rooms', (req, res) => {
  if (!adminGuard(req, res)) return;
  const now = Date.now();
  const list = [];
  rooms.forEach((room, id) => list.push({
    id,
    users: room.users.size,
    strokes: room.history.length,
    lastActivity: room.lastActivity || 0,
    audience: room.audience || null,
    // null while occupied or for featured rooms (never auto-close); else ms left.
    expiresInMs: room.users.size > 0 || FEATURED_CODES.has(id)
      ? null
      : Math.max(0, allowedIdleMs(room) - (now - (room.lastActivity || now))),
  }));
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

// Permanently delete a room: disconnect everyone, drop it from memory + disk.
app.post('/api/admin/rooms/:id/delete', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = String(req.params.id).toUpperCase().slice(0, 16);
  if (FEATURED_CODES.has(id)) {
    return res.status(400).json({ error: 'cannot_delete_featured' });
  }
  closeRoom(id, 'a moderator closed this room');
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

// ---- Rooms: audience + discovery ------------------------------------------
// A signed-in grown-up creates a public (kid_safe) room that shows up in the
// discovery lobby; invite-code rooms stay private ("friends") and are created
// lazily on first WS connect, exactly as before.
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i += 1) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
  } while (FEATURED_CODES.has(code) || rooms.has(code) || existsSync(roomFile(code)));
  return code;
}

// Tiny in-memory rate limiter (per profile/IP) so room creation can't be spammed.
const createHits = new Map();
function rateOk(key, max = 8, windowMs = 60_000) {
  const now = Date.now();
  const arr = (createHits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    createHits.set(key, arr);
    return false;
  }
  arr.push(now);
  createHits.set(key, arr);
  return true;
}

function bearerToken(req) {
  const auth = req.get('authorization') || '';
  return /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
}

// Create a room with an explicit audience. Public (kid_safe) rooms require a
// signed-in owner; adult_18 is disabled; friends rooms don't need this (an
// invite code lazily creates a private room on connect).
app.post('/api/rooms', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body || {};
  const audience = typeof body.audience === 'string' ? body.audience : 'kid_safe';
  if (!['kid_safe', 'friends', 'adult_18'].includes(audience)) {
    return res.status(400).json({ error: 'bad_audience' });
  }
  if (audience === 'adult_18') {
    return res.status(403).json({ error: 'adult_disabled' });
  }
  const token = bearerToken(req);
  const identity = token ? await verifyAccessToken(token) : null;
  // A public room needs a grown-up owner who can moderate it.
  if (audience === 'kid_safe' && !identity) {
    return res.status(401).json({ error: 'signin_required' });
  }
  const rlKey = (identity && identity.profileId) || req.ip || 'anon';
  if (!rateOk(`room:${rlKey}`)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  const code = genRoomCode();
  const room = getRoom(code); // materializes with default audience; we override
  room.audience = audience;
  room.listed = audience === 'kid_safe' ? body.listed !== false : false;
  room.title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 40) : null;
  if (identity) room.ownerProfileId = identity.profileId;
  persistRoom(code);
  res.json({ code, audience: room.audience, listed: room.listed, title: room.title });
});

// The discovery lobby source: live, listed, kid_safe rooms only. Sanitized —
// never participant names, chat, raw strokes, owner ids, or private rooms.
app.get('/api/rooms/public', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  FEATURED_ROOMS.forEach((f) => getRoom(f.code)); // always surface the prompt rooms, even empty
  const list = [];
  rooms.forEach((room, code) => {
    if (room.audience !== 'kid_safe' || !room.listed) return;
    const users = room.users.size;
    const featured = FEATURED_CODES.has(code);
    if (users === 0 && !featured) return; // hide empty ad-hoc rooms; keep the prompt rooms
    const f = featured ? FEATURED_ROOMS[FEATURED_INDEX.get(code)] : null;
    list.push({
      code,
      title: room.title || (f ? f.title : null),
      users,
      sheetId: room.sheetId || null,
      lastActivity: room.lastActivity || 0,
      hasHost: Array.from(room.users.values()).some((u) => isHost(room, u)),
      featured,
      emoji: f ? f.emoji : null,
      prompt: f ? dailyPromptFor(f) : null,
    });
  });
  // Featured prompt rooms first (in their defined order), then live ad-hoc rooms
  // by headcount — so the lobby always leads with the curated, always-open rooms.
  list.sort((a, b) => {
    const ai = a.featured ? FEATURED_INDEX.get(a.code) : 999;
    const bi = b.featured ? FEATURED_INDEX.get(b.code) : 999;
    if (ai !== bi) return ai - bi;
    return b.users - a.users || b.lastActivity - a.lastActivity;
  });
  res.json({ rooms: list.slice(0, 60) });
});

// ---- Coloring sheets ------------------------------------------------------
// Admin uploads line-art images; anyone can list them and apply one to a room.
const SHEETS_FILE = join(DATA_DIR, '.sheets.json');
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

// ---- Coloring sheet library (6k+ static sheets) ---------------------------
// Full PNGs + generated webp thumbnails are served statically from a directory
// (a Docker volume in production); a filename-derived search index lets kids
// find a sheet with no AI classifier. Build it with scripts/prep-sheets.mjs.
const COLORING_DIR = process.env.COLORING_DIR || join(__dirname, 'coloring-library');
app.use('/coloring-sheets/full', express.static(join(COLORING_DIR, 'full'), { maxAge: '7d', immutable: true }));
app.use('/coloring-sheets/thumbs', express.static(join(COLORING_DIR, 'thumbs'), { maxAge: '7d', immutable: true }));

let coloringIndexRaw = null;
let coloringSheets = [];
function loadColoringIndex() {
  if (coloringIndexRaw !== null) return;
  try {
    coloringIndexRaw = readFileSync(join(COLORING_DIR, 'index.json'), 'utf8');
    coloringSheets = JSON.parse(coloringIndexRaw).sheets || [];
  } catch {
    coloringIndexRaw = JSON.stringify({ count: 0, sheets: [] });
    coloringSheets = [];
  }
}

// The full search index (id + title + searchable text); the client fetches it
// once and searches in-browser. Hundreds of KB, gzipped + cached.
app.get('/api/coloring-sheets', (_req, res) => {
  loadColoringIndex();
  res.set('Cache-Control', 'public, max-age=300');
  res.type('application/json').send(coloringIndexRaw);
});

// "Today's theme": admin pick -> calendar/holiday match -> deterministic daily
// rotation. Returns one sheet { id, title } (or null when the library is empty).
const SHEET_THEME_FILE = join(DATA_DIR, '.sheet-theme.json');
const HOLIDAYS = [
  { mmdd: '07-04', win: 4, terms: ['july', 'fireworks', 'patriotic'] },
  { mmdd: '12-25', win: 10, terms: ['christmas', 'santa', 'snowman', 'winter'] },
  { mmdd: '10-31', win: 7, terms: ['halloween', 'pumpkin', 'ghost'] },
  { mmdd: '02-14', win: 3, terms: ['valentine', 'heart', 'love'] },
  { mmdd: '03-17', win: 2, terms: ['leprechaun', 'patrick', 'shamrock'] },
  { mmdd: '11-25', win: 4, terms: ['thanksgiving', 'turkey'] },
  { mmdd: '04-12', win: 16, terms: ['easter', 'bunny', 'egg'] },
  { mmdd: '01-01', win: 2, terms: ['year', 'fireworks'] },
];
const daysSinceEpoch = (d) => Math.floor(d.getTime() / 86400000);

app.get('/api/coloring-sheets/today', (_req, res) => {
  loadColoringIndex();
  res.set('Cache-Control', 'public, max-age=600');
  if (!coloringSheets.length) return res.json({ sheet: null });
  const now = new Date();
  const seed = daysSinceEpoch(now);

  // 1) Admin override for today.
  try {
    const theme = JSON.parse(readFileSync(SHEET_THEME_FILE, 'utf8'));
    const todayStr = now.toISOString().slice(0, 10);
    if (theme && theme.sheetId && (!theme.date || theme.date === todayStr)) {
      const match = coloringSheets.find((s) => s.id === theme.sheetId);
      if (match) return res.json({ sheet: { id: match.id, title: match.title }, source: 'admin' });
    }
  } catch { /* no override set */ }

  // 2) Holiday match within a window around the date.
  for (const h of HOLIDAYS) {
    const [hm, hd] = h.mmdd.split('-').map(Number);
    const target = new Date(now.getFullYear(), hm - 1, hd);
    if (Math.abs(daysSinceEpoch(now) - daysSinceEpoch(target)) <= h.win) {
      const matches = coloringSheets.filter((s) => h.terms.some((t) => s.q.includes(t)));
      if (matches.length) {
        const pick = matches[seed % matches.length];
        return res.json({ sheet: { id: pick.id, title: pick.title }, source: 'holiday' });
      }
    }
  }

  // 3) Deterministic daily rotation (same sheet for everyone that day).
  const pick = coloringSheets[seed % coloringSheets.length];
  return res.json({ sheet: { id: pick.id, title: pick.title }, source: 'daily' });
});

// Admin: set or clear today's themed sheet.
app.post('/api/admin/sheet-theme', (req, res) => {
  if (!adminGuard(req, res)) return;
  const { sheetId } = req.body || {};
  try {
    const payload = sheetId
      ? { sheetId: String(sheetId).slice(0, 200), date: new Date().toISOString().slice(0, 10) }
      : {};
    writeFileSync(SHEET_THEME_FILE, JSON.stringify(payload));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'failed' });
  }
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
    // Don't serve the SPA shell for missing API / asset requests — 404 instead,
    // so a broken image is a 404, not an HTML page with a 200.
    if (req.path.startsWith('/api/') || req.path.startsWith('/coloring-sheets/')) {
      res.status(404).json({ error: 'not found' });
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
