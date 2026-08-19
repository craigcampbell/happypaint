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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, readdirSync, appendFileSync, statSync, promises as fsp } from 'fs';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { monitorEventLoopDelay } from 'perf_hooks';
import { verifyAccessToken } from './server/pocketbaseAuth.js';
import { scan } from './server/moderation/textFilter.js';
import { pickWordChoices } from './server/gameWords.js';
import { dailyChallenge } from './server/dailyChallenges.js';
import { questMissions, questSetFor } from './server/questDeck.js';
import { defaultStorybook, storybookPrompt } from './server/storybookPrompts.js';

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
const MAX_HISTORY = Number(process.env.MAX_HISTORY || 20000);
const MAX_ROOM_USERS = Number(process.env.MAX_ROOM_USERS || 30);
const MAX_SPECTATORS = Number(process.env.MAX_SPECTATORS || 40); // read-only homepage viewers per public room
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
const wss = new WebSocketServer({
  server,
  path: '/ws',
  // Compress frames >1KB (the join-history payload shrinks ~8x). No context
  // takeover keeps per-socket memory flat; browsers negotiate this natively.
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
  // Bound inbound frames (ws defaults to 100MiB!). The biggest legitimate
  // message is an image op's dataURL — comfortably under this.
  maxPayload: 16 * 1024 * 1024,
});

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

// ---- Lightweight product analytics ---------------------------------------
// Admin-only, bounded, and privacy-light: no raw IPs or user agents are stored.
// Location is a coarse deploy-provided country code when present; otherwise the
// client timezone/locale gives a rough "where in the world" hint.
const ANALYTICS_FILE = join(DATA_DIR, '.analytics.json');
const ANALYTICS_SESSION_CAP = Number(process.env.ANALYTICS_SESSION_CAP || 2000);
const ANALYTICS_USER_CAP = Number(process.env.ANALYTICS_USER_CAP || 1000);
const ANALYTICS_ROOM_CAP = Number(process.env.ANALYTICS_ROOM_CAP || 500);
const ANALYTICS_GALLERY_CAP = Number(process.env.ANALYTICS_GALLERY_CAP || 500);
const analyticsActiveSessions = new Map();
let analyticsPersistTimer = null;

function blankAnalytics() {
  return {
    version: 1,
    totals: {
      sessions: 0,
      signedInSessions: 0,
      anonymousSessions: 0,
      roomClears: 0,
      adminRoomClears: 0,
      gallerySaves: 0,
      signedInGallerySaves: 0,
      anonymousGallerySaves: 0,
      strokes: 0,
      drawOps: 0,
      points: 0,
      chats: 0,
    },
    users: {},
    rooms: {},
    brushes: {},
    countries: {},
    timezones: {},
    gallerySaves: [],
    sessions: [],
  };
}

let analytics = blankAnalytics();
try {
  const loaded = JSON.parse(readFileSync(ANALYTICS_FILE, 'utf8'));
  analytics = { ...blankAnalytics(), ...loaded };
  analytics.totals = { ...blankAnalytics().totals, ...(loaded.totals || {}) };
  analytics.users = loaded.users && typeof loaded.users === 'object' ? loaded.users : {};
  analytics.rooms = loaded.rooms && typeof loaded.rooms === 'object' ? loaded.rooms : {};
  analytics.brushes = loaded.brushes && typeof loaded.brushes === 'object' ? loaded.brushes : {};
  analytics.countries = loaded.countries && typeof loaded.countries === 'object' ? loaded.countries : {};
  analytics.timezones = loaded.timezones && typeof loaded.timezones === 'object' ? loaded.timezones : {};
  analytics.gallerySaves = Array.isArray(loaded.gallerySaves) ? loaded.gallerySaves : [];
  analytics.sessions = Array.isArray(loaded.sessions) ? loaded.sessions : [];
} catch {
  analytics = blankAnalytics();
}

function topKey(bag) {
  let winner = null;
  let best = 0;
  if (!bag || typeof bag !== 'object') return null;
  for (const [key, value] of Object.entries(bag)) {
    const n = Number(value) || 0;
    if (n > best) {
      winner = key;
      best = n;
    }
  }
  return winner;
}

function bagList(bag, limit = 20) {
  if (!bag || typeof bag !== 'object') return [];
  return Object.entries(bag)
    .map(([id, count]) => ({ id, count: Number(count) || 0 }))
    .filter((item) => item.id && item.count > 0)
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function bumpBag(bag, key, amount = 1) {
  const clean = typeof key === 'string' ? key.trim().slice(0, 80) : '';
  if (!clean) return;
  bag[clean] = (Number(bag[clean]) || 0) + amount;
}

function normalizeAnalytics() {
  const now = Date.now();
  analytics.sessions = analytics.sessions
    .filter((s) => s && typeof s === 'object' && s.id)
    .map((s) => {
      if (!s.leftAt) {
        const last = Number(s.lastSeen || s.joinedAt || now);
        return { ...s, active: false, leftAt: last, durationSec: Math.max(0, Math.round((last - (s.joinedAt || last)) / 1000)) };
      }
      return { ...s, active: false };
    });
  for (const user of Object.values(analytics.users)) {
    if (user && typeof user === 'object') user.activeSessions = 0;
  }
  for (const room of Object.values(analytics.rooms)) {
    if (room && typeof room === 'object') room.activeSessions = 0;
  }
}
normalizeAnalytics();

function trimAnalytics() {
  analytics.sessions.sort((a, b) => (b.joinedAt || 0) - (a.joinedAt || 0));
  if (analytics.sessions.length > ANALYTICS_SESSION_CAP) analytics.sessions.length = ANALYTICS_SESSION_CAP;

  const userEntries = Object.entries(analytics.users)
    .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));
  if (userEntries.length > ANALYTICS_USER_CAP) {
    analytics.users = Object.fromEntries(userEntries.slice(0, ANALYTICS_USER_CAP));
  }

  const roomEntries = Object.entries(analytics.rooms)
    .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));
  if (roomEntries.length > ANALYTICS_ROOM_CAP) {
    analytics.rooms = Object.fromEntries(roomEntries.slice(0, ANALYTICS_ROOM_CAP));
  }

  if (analytics.gallerySaves.length > ANALYTICS_GALLERY_CAP) {
    analytics.gallerySaves.length = ANALYTICS_GALLERY_CAP;
  }
}

function persistAnalyticsNow() {
  trimAnalytics();
  try {
    writeFileSync(ANALYTICS_FILE, JSON.stringify(analytics));
  } catch {
    // Analytics must never break painting.
  }
}

function scheduleAnalyticsPersist() {
  if (analyticsPersistTimer) return;
  analyticsPersistTimer = setTimeout(() => {
    analyticsPersistTimer = null;
    persistAnalyticsNow();
  }, 3000);
  if (analyticsPersistTimer.unref) analyticsPersistTimer.unref();
}

function cleanCountry(value) {
  const cc = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(cc) && cc !== 'XX' ? cc : null;
}

function countryFromReq(req) {
  return cleanCountry(
    req.headers['cf-ipcountry']
    || req.headers['x-vercel-ip-country']
    || req.headers['x-country-code']
    || req.headers['cloudfront-viewer-country'],
  );
}

function deviceTypeFromReq(req) {
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (/(ipad|tablet|kindle|silk)/.test(ua)) return 'tablet';
  if (/(mobile|android|iphone|ipod)/.test(ua)) return 'mobile';
  if (ua) return 'desktop';
  return 'unknown';
}

function analyticsUserKey(user) {
  return user.profileId ? `pb:${user.profileId}` : `anon:${user.id}`;
}

function ensureAnalyticsRoom(roomId) {
  const id = String(roomId || 'UNKNOWN').slice(0, 32);
  let room = analytics.rooms[id];
  if (!room) {
    room = {
      id,
      firstSeen: Date.now(),
      lastSeen: 0,
      sessions: 0,
      activeSessions: 0,
      totalDurationSec: 0,
      strokes: 0,
      drawOps: 0,
      points: 0,
      clears: 0,
      chats: 0,
      gallerySaves: 0,
      brushes: {},
      countries: {},
      timezones: {},
    };
    analytics.rooms[id] = room;
  }
  return room;
}

function ensureAnalyticsUserFromKey(userKey, profileId = null, signedIn = false) {
  let user = analytics.users[userKey];
  if (!user) {
    user = {
      userKey,
      profileId: profileId || null,
      signedIn: !!signedIn,
      firstSeen: Date.now(),
      lastSeen: 0,
      sessions: 0,
      activeSessions: 0,
      totalDurationSec: 0,
      rooms: {},
      brushes: {},
      countries: {},
      timezones: {},
      strokes: 0,
      drawOps: 0,
      points: 0,
      clears: 0,
      chats: 0,
      gallerySaves: 0,
      lastRoom: null,
      lastDeviceType: null,
      lastLocale: null,
      displayName: null,
    };
    analytics.users[userKey] = user;
  }
  if (profileId) {
    user.profileId = profileId;
    user.signedIn = true;
  }
  return user;
}

function ensureAnalyticsUser(user) {
  const key = analyticsUserKey(user);
  const record = ensureAnalyticsUserFromKey(key, user.profileId || null, !!user.profileId);
  if (!user.profileId && user.name) {
    record.displayName = String(user.name).slice(0, 24);
  }
  return record;
}

function findAnalyticsSession(user) {
  const sid = user && user.analyticsSessionId;
  return sid ? analyticsActiveSessions.get(sid) : null;
}

function analyticsStartSession(roomId, user, req) {
  const now = Date.now();
  const userKey = analyticsUserKey(user);
  const signedIn = !!user.profileId;
  const country = countryFromReq(req);
  const deviceType = deviceTypeFromReq(req);
  const id = `ses_${now.toString(36)}_${randomBytes(4).toString('hex')}`;
  const session = {
    id,
    userKey,
    profileId: user.profileId || null,
    signedIn,
    displayName: signedIn ? null : String(user.name || 'Guest').slice(0, 24),
    room: roomId,
    joinedAt: now,
    lastSeen: now,
    leftAt: null,
    durationSec: 0,
    active: true,
    country,
    timezone: null,
    locale: null,
    deviceType,
    pointer: null,
    viewportBucket: null,
    strokes: 0,
    drawOps: 0,
    points: 0,
    clears: 0,
    chats: 0,
    brushes: {},
  };
  analytics.sessions.unshift(session);
  analyticsActiveSessions.set(id, session);
  user.analyticsSessionId = id;
  user.analyticsStrokeIds = new Set();

  analytics.totals.sessions += 1;
  if (signedIn) analytics.totals.signedInSessions += 1;
  else analytics.totals.anonymousSessions += 1;
  if (country) bumpBag(analytics.countries, country);

  const userRecord = ensureAnalyticsUser(user);
  userRecord.sessions += 1;
  userRecord.activeSessions = (Number(userRecord.activeSessions) || 0) + 1;
  userRecord.lastSeen = now;
  userRecord.lastRoom = roomId;
  userRecord.lastDeviceType = deviceType;
  bumpBag(userRecord.rooms, roomId);
  if (country) bumpBag(userRecord.countries, country);

  const roomRecord = ensureAnalyticsRoom(roomId);
  roomRecord.sessions += 1;
  roomRecord.activeSessions = (Number(roomRecord.activeSessions) || 0) + 1;
  roomRecord.lastSeen = now;
  if (country) bumpBag(roomRecord.countries, country);

  scheduleAnalyticsPersist();
}

function cleanLocale(value) {
  const v = String(value || '').trim().slice(0, 24);
  return /^[a-z]{2,3}(-[A-Z0-9]{2,8})?$/i.test(v) ? v : null;
}

function cleanTimezone(value) {
  const v = String(value || '').trim().slice(0, 48);
  return /^[A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?$/.test(v) || v === 'UTC' ? v : null;
}

function bucketNumber(value, step) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / step) * step;
}

function analyticsUpdateClientInfo(user, data) {
  const session = findAnalyticsSession(user);
  if (!session) return;
  const now = Date.now();
  const timezone = cleanTimezone(data.timezone);
  const locale = cleanLocale(data.locale);
  const pointer = ['coarse', 'fine', 'none'].includes(data.pointer) ? data.pointer : null;
  const vw = bucketNumber(data.viewportW, 100);
  const vh = bucketNumber(data.viewportH, 100);
  session.lastSeen = now;
  if (timezone) session.timezone = timezone;
  if (locale) session.locale = locale;
  if (pointer) session.pointer = pointer;
  if (vw && vh) session.viewportBucket = `${vw}x${vh}`;

  const userRecord = analytics.users[session.userKey];
  if (userRecord) {
    userRecord.lastSeen = now;
    if (timezone) bumpBag(userRecord.timezones, timezone);
    if (locale) userRecord.lastLocale = locale;
  }
  const roomRecord = analytics.rooms[session.room];
  if (roomRecord) {
    roomRecord.lastSeen = now;
    if (timezone) bumpBag(roomRecord.timezones, timezone);
  }
  if (timezone) bumpBag(analytics.timezones, timezone);
  scheduleAnalyticsPersist();
}

function brushNameFromOp(op) {
  const settings = op && op.settings;
  if (!settings || typeof settings !== 'object') return null;
  if (typeof settings.brush === 'string' && settings.brush.trim()) return settings.brush.trim().slice(0, 40);
  if (settings.dab && settings.dab.shape === 'stamp') return 'imported stamp';
  return 'unknown';
}

function analyticsRecordDraw(roomId, user, op) {
  const session = findAnalyticsSession(user);
  if (!session || !op || op.kind !== 'draw') return;
  const now = Date.now();
  const points = Array.isArray(op.points) ? op.points.length : 0;
  const userRecord = analytics.users[session.userKey];
  const roomRecord = ensureAnalyticsRoom(roomId);
  session.lastSeen = now;
  session.drawOps += 1;
  session.points += points;
  analytics.totals.drawOps += 1;
  analytics.totals.points += points;
  roomRecord.lastSeen = now;
  roomRecord.drawOps += 1;
  roomRecord.points += points;
  if (userRecord) {
    userRecord.lastSeen = now;
    userRecord.drawOps += 1;
    userRecord.points += points;
  }

  const strokeId = op.strokeId ? String(op.strokeId).slice(0, 80) : null;
  const seen = user.analyticsStrokeIds || (user.analyticsStrokeIds = new Set());
  const shouldCountStroke = strokeId ? !seen.has(strokeId) : !!op.settings;
  if (strokeId && shouldCountStroke) {
    seen.add(strokeId);
    if (seen.size > 4000) seen.clear();
  }
  if (shouldCountStroke) {
    const brush = brushNameFromOp(op) || 'unknown';
    session.strokes += 1;
    bumpBag(session.brushes, brush);
    analytics.totals.strokes += 1;
    bumpBag(analytics.brushes, brush);
    roomRecord.strokes += 1;
    bumpBag(roomRecord.brushes, brush);
    if (userRecord) {
      userRecord.strokes += 1;
      bumpBag(userRecord.brushes, brush);
    }
  }
  scheduleAnalyticsPersist();
}

function analyticsRecordChat(roomId, user) {
  const session = findAnalyticsSession(user);
  if (!session) return;
  const userRecord = analytics.users[session.userKey];
  const roomRecord = ensureAnalyticsRoom(roomId);
  session.chats += 1;
  session.lastSeen = Date.now();
  analytics.totals.chats += 1;
  roomRecord.chats += 1;
  if (userRecord) {
    userRecord.chats += 1;
    userRecord.lastSeen = session.lastSeen;
  }
  scheduleAnalyticsPersist();
}

function analyticsRecordClear(roomId, user, source = 'user') {
  const session = user ? findAnalyticsSession(user) : null;
  const userRecord = session ? analytics.users[session.userKey] : null;
  const roomRecord = ensureAnalyticsRoom(roomId);
  const now = Date.now();
  analytics.totals.roomClears += 1;
  if (source === 'admin') analytics.totals.adminRoomClears += 1;
  roomRecord.clears += 1;
  roomRecord.lastSeen = now;
  if (session) {
    session.clears += 1;
    session.lastSeen = now;
  }
  if (userRecord) {
    userRecord.clears += 1;
    userRecord.lastSeen = now;
  }
  scheduleAnalyticsPersist();
}

function analyticsRecordGallerySave(key, req) {
  const now = Date.now();
  const signedIn = String(key || '').startsWith('pb_');
  const profileId = signedIn ? String(key).slice(3) : null;
  const country = countryFromReq(req);
  analytics.totals.gallerySaves += 1;
  if (signedIn) analytics.totals.signedInGallerySaves += 1;
  else analytics.totals.anonymousGallerySaves += 1;
  if (country) bumpBag(analytics.countries, country);
  analytics.gallerySaves.unshift({
    ts: now,
    signedIn,
    profileId: profileId || null,
    country,
  });
  if (profileId) {
    const userRecord = ensureAnalyticsUserFromKey(`pb:${profileId}`, profileId, true);
    userRecord.gallerySaves += 1;
    userRecord.lastSeen = now;
    if (country) bumpBag(userRecord.countries, country);
  }
  scheduleAnalyticsPersist();
}

function analyticsEndSession(user) {
  const session = findAnalyticsSession(user);
  if (!session) return;
  const now = Date.now();
  const durationSec = Math.max(0, Math.round((now - (session.joinedAt || now)) / 1000));
  session.leftAt = now;
  session.lastSeen = now;
  session.durationSec = durationSec;
  session.active = false;
  analyticsActiveSessions.delete(session.id);

  const userRecord = analytics.users[session.userKey];
  if (userRecord) {
    userRecord.activeSessions = Math.max(0, (Number(userRecord.activeSessions) || 0) - 1);
    userRecord.totalDurationSec += durationSec;
    userRecord.lastSeen = now;
  }
  const roomRecord = analytics.rooms[session.room];
  if (roomRecord) {
    roomRecord.activeSessions = Math.max(0, (Number(roomRecord.activeSessions) || 0) - 1);
    roomRecord.totalDurationSec += durationSec;
    roomRecord.lastSeen = now;
  }
  user.analyticsSessionId = null;
  user.analyticsStrokeIds = null;
  scheduleAnalyticsPersist();
}

function analyticsScrubProfile(profileId) {
  const pid = String(profileId || '');
  if (!pid) return 0;
  let scrubbed = 0;
  for (const session of analytics.sessions) {
    if (session.profileId === pid) {
      session.profileId = null;
      session.userKey = 'deleted';
      session.signedIn = false;
      session.displayName = '[deleted]';
      scrubbed += 1;
    }
  }
  for (const save of analytics.gallerySaves) {
    if (save.profileId === pid) {
      save.profileId = null;
      save.signedIn = false;
      scrubbed += 1;
    }
  }
  const key = `pb:${pid}`;
  if (analytics.users[key]) {
    delete analytics.users[key];
    scrubbed += 1;
  }
  if (scrubbed) scheduleAnalyticsPersist();
  return scrubbed;
}

function analyticsSnapshot() {
  const now = Date.now();
  const sessions = analytics.sessions
    .map((s) => {
      const active = analyticsActiveSessions.has(s.id);
      return {
        id: s.id,
        signedIn: !!s.signedIn,
        displayName: s.displayName || null,
        account: s.profileId ? s.profileId.slice(0, 8) : null,
        room: s.room,
        joinedAt: s.joinedAt || 0,
        leftAt: active ? null : s.leftAt || null,
        active,
        durationSec: active ? Math.max(0, Math.round((now - (s.joinedAt || now)) / 1000)) : Number(s.durationSec) || 0,
        country: s.country || null,
        timezone: s.timezone || null,
        locale: s.locale || null,
        deviceType: s.deviceType || 'unknown',
        pointer: s.pointer || null,
        viewportBucket: s.viewportBucket || null,
        strokes: Number(s.strokes) || 0,
        drawOps: Number(s.drawOps) || 0,
        points: Number(s.points) || 0,
        clears: Number(s.clears) || 0,
        chats: Number(s.chats) || 0,
        topBrush: topKey(s.brushes),
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.joinedAt - a.joinedAt)
    .slice(0, 120);

  const users = Object.values(analytics.users)
    .map((u) => ({
      label: u.signedIn && u.profileId ? `Account ${u.profileId.slice(0, 8)}` : u.displayName || 'Anonymous guest',
      signedIn: !!u.signedIn,
      active: (Number(u.activeSessions) || 0) > 0,
      activeSessions: Number(u.activeSessions) || 0,
      sessions: Number(u.sessions) || 0,
      firstSeen: u.firstSeen || 0,
      lastSeen: u.lastSeen || 0,
      totalDurationSec: Number(u.totalDurationSec) || 0,
      lastRoom: u.lastRoom || null,
      country: topKey(u.countries),
      timezone: topKey(u.timezones),
      deviceType: u.lastDeviceType || 'unknown',
      locale: u.lastLocale || null,
      topBrush: topKey(u.brushes),
      strokes: Number(u.strokes) || 0,
      drawOps: Number(u.drawOps) || 0,
      points: Number(u.points) || 0,
      clears: Number(u.clears) || 0,
      chats: Number(u.chats) || 0,
      gallerySaves: Number(u.gallerySaves) || 0,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeen - a.lastSeen)
    .slice(0, 120);

  const roomStats = Object.values(analytics.rooms)
    .map((r) => ({
      id: r.id,
      activeSessions: Number(r.activeSessions) || 0,
      sessions: Number(r.sessions) || 0,
      totalDurationSec: Number(r.totalDurationSec) || 0,
      lastSeen: r.lastSeen || 0,
      strokes: Number(r.strokes) || 0,
      drawOps: Number(r.drawOps) || 0,
      points: Number(r.points) || 0,
      clears: Number(r.clears) || 0,
      chats: Number(r.chats) || 0,
      gallerySaves: Number(r.gallerySaves) || 0,
      topBrush: topKey(r.brushes),
      country: topKey(r.countries),
      timezone: topKey(r.timezones),
    }))
    .sort((a, b) => b.activeSessions - a.activeSessions || b.lastSeen - a.lastSeen || b.sessions - a.sessions)
    .slice(0, 100);

  const signedInUsers = users.filter((u) => u.signedIn).length;
  const anonymousUsers = users.filter((u) => !u.signedIn).length;
  const totalDurationSec = sessions.reduce((sum, s) => sum + s.durationSec, 0);
  const completedSessions = sessions.filter((s) => !s.active && s.durationSec > 0).length;

  return {
    totals: {
      ...analytics.totals,
      activeSessions: analyticsActiveSessions.size,
      knownUsers: users.length,
      signedInUsers,
      anonymousUsers,
      avgSessionSec: completedSessions ? Math.round(totalDurationSec / completedSessions) : 0,
    },
    users,
    sessions,
    rooms: roomStats,
    brushes: bagList(analytics.brushes, 30),
    countries: bagList(analytics.countries, 30),
    timezones: bagList(analytics.timezones, 30),
    gallerySaves: analytics.gallerySaves.slice(0, 80).map((save) => ({
      ts: save.ts,
      signedIn: !!save.signedIn,
      account: save.profileId ? save.profileId.slice(0, 8) : null,
      country: save.country || null,
    })),
    caps: {
      sessions: ANALYTICS_SESSION_CAP,
      users: ANALYTICS_USER_CAP,
      rooms: ANALYTICS_ROOM_CAP,
      gallerySaves: ANALYTICS_GALLERY_CAP,
    },
  };
}

// Per-room mural persistence: the op history is written to disk (debounced) and
// reloaded on startup, so a server restart doesn't wipe the painting and late
// joiners always replay the full mural.
const ROOM_DIR = process.env.ROOM_DIR || join(DATA_DIR, '.rooms');
const persistTimers = new Map();
function roomFile(roomId) {
  return join(ROOM_DIR, `${String(roomId).replace(/[^A-Z0-9_-]/gi, '').slice(0, 32)}.json`);
}

// ---- Chat persistence -----------------------------------------------------
// Two stores, by purpose:
//  1) room.chat — a capped in-memory buffer (persisted in the room file) used to
//     give late joiners context + recent context for reports.
//  2) An append-only per-room audit log (.chatlog/<CODE>.jsonl) — the durable
//     moderation/audit trail. Bounded per room so disk can't grow forever.
// Both store the display name + message + the opaque profileId (when signed in)
// so a future account-deletion scrub can redact by id.
const CHAT_BUFFER_MAX = 200; // messages kept in memory + the room file
// Tapback emoji a chat bubble can carry (iMessage-style) — server allowlist;
// the client tray mirrors this. Keep small + universally readable.
const CHAT_TAPBACKS = ['❤️', '😂', '🔥', '👍', '😮', '🎨'];
// Big animated "hype" reactions — curated KINDS, rendered client-side as pure
// CSS celebrations (never external media; this is the kid-safe Giphy stand-in).
const HYPE_KINDS = ['confetti', 'fire', 'laugh', 'heart', 'clap', 'rainbow', 'star', 'mind', 'unicorn', 'hundred'];
const CHAT_LOG_DIR = process.env.CHAT_LOG_DIR || join(DATA_DIR, '.chatlog');
const CHAT_LOG_CAP_BYTES = 2 * 1024 * 1024; // ~2MB per room; trim oldest half past this
function chatLogFile(roomId) {
  return join(CHAT_LOG_DIR, `${String(roomId).replace(/[^A-Z0-9_-]/gi, '').slice(0, 32)}.jsonl`);
}
function appendChatAudit(roomId, entry) {
  try {
    mkdirSync(CHAT_LOG_DIR, { recursive: true });
    const file = chatLogFile(roomId);
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    // Bound disk: once a room's log passes the cap, keep only the newer half.
    let size = 0;
    try { size = statSync(file).size; } catch { size = 0; }
    if (size > CHAT_LOG_CAP_BYTES) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
    }
  } catch {
    // Best-effort — never let audit logging break a chat message.
  }
}

// Retention sweep: chat audit logs exist for moderation context and deletion
// scrubs, not forever. Guests can't be scrubbed by profileId (they have none),
// so time is the only eraser — drop any room log untouched for 90 days.
// Defense-in-depth on top of the per-account scrub endpoint.
const CHAT_LOG_TTL_MS = Number(process.env.CHAT_LOG_TTL_DAYS || 90) * 86_400_000;
async function sweepChatLogs() {
  let files = [];
  try { files = (await fsp.readdir(CHAT_LOG_DIR)).filter((f) => f.endsWith('.jsonl')); } catch { return; }
  const cutoff = Date.now() - CHAT_LOG_TTL_MS;
  for (const f of files) {
    const p = join(CHAT_LOG_DIR, f);
    try {
      const st = await fsp.stat(p);
      if (st.mtimeMs < cutoff) await fsp.unlink(p);
    } catch {
      // Best-effort — a locked/vanished file just waits for the next sweep.
    }
  }
}
setInterval(() => { sweepChatLogs(); }, 6 * 3_600_000).unref();
sweepChatLogs();

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
      chat: Array.isArray(data.chat) ? data.chat.slice(-CHAT_BUFFER_MAX) : [],
      chatSeq: Number(data.chatSeq) || 0,
      // Wet-canvas toggle + the last theme-vote winner both survive restarts.
      wetCanvas: !!data.wetCanvas,
      customPrompt: typeof data.customPrompt === 'string' ? data.customPrompt : null,
      // Shared-animation state: the frame list, its scenes, and whether the
      // room has the film strip enabled (private rooms opt in; FLIPBOOK is on).
      frames: Array.isArray(data.frames) ? data.frames : null,
      scenes: Array.isArray(data.scenes) ? data.scenes : null,
      animation: !!data.animation,
      game: !!data.game, // private-room Draw & Guess opt-in survives restarts
      phone: !!data.phone, // private-room Draw Phone opt-in survives restarts
      dailyDate: /^\d{4}-\d{2}-\d{2}$/.test(String(data.dailyDate || '')) ? data.dailyDate : null,
      productionId: typeof data.productionId === 'string' ? data.productionId.slice(0, 32) : null,
      symmetry: data.symmetry && typeof data.symmetry === 'object' ? data.symmetry : null,
      quests: data.quests && typeof data.quests === 'object' ? data.quests : null,
      storybook: data.storybook && typeof data.storybook === 'object' ? data.storybook : null,
      remixSource: data.remixSource && typeof data.remixSource === 'object' ? data.remixSource : null,
      // Server-side capability secrets for cross-room @mention watching.
      mentionKeys: Array.isArray(data.mentionKeys) ? data.mentionKeys : [],
    };
  } catch {
    return { history: [], sheetId: null, ownerProfileId: null, coHosts: [], mutedProfileIds: [], locked: false, title: null, audience: null, listed: null, hiddenOpIds: [], userSeconds: 0, chat: [], wetCanvas: false, customPrompt: null, frames: null, scenes: null, animation: false, game: false, phone: false, dailyDate: null, productionId: null, symmetry: null, quests: null, storybook: null, remixSource: null, mentionKeys: [] };
  }
}
// Write-behind saves: rooms currently mid-write, and rooms whose save fired
// while a write was in flight (they re-run once the current write settles).
// Keeps a busy room's ~16MB JSON write off the event loop so op relay never
// stalls behind disk I/O; loadRoom stays sync (startup only).
const persistInFlight = new Set();
const persistDirty = new Set();
async function saveRoomNow(roomId) {
  if (persistInFlight.has(roomId)) {
    persistDirty.add(roomId); // a write is already on the wire — re-queue
    return;
  }
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }
  persistInFlight.add(roomId);
  try {
    mkdirSync(ROOM_DIR, { recursive: true });
    // Note: room.lastCleared is intentionally in-memory only — never persisted.
    const json = JSON.stringify({
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
      chat: (room.chat || []).slice(-CHAT_BUFFER_MAX),
      chatSeq: room.chatSeq || 0,
      wetCanvas: !!room.wetCanvas,
      customPrompt: room.customPrompt || null,
      frames: room.frames,
      scenes: room.scenes,
      animation: !!room.animationEnabled,
      game: !!room.gameEnabled,
      phone: !!room.phoneEnabled,
      dailyDate: room.dailyDate || null,
      productionId: room.productionId || null,
      symmetry: room.symmetry,
      quests: room.quests ? {
        setId: room.quests.setId,
        missionIds: room.quests.missionIds,
        completedIds: Array.from(room.quests.completedIds || []),
      } : null,
      storybook: room.storybook || null,
      remixSource: room.remixSource || null,
      // Mention-watch capability keys (see issueMentionKey). Server-side only:
      // this file never leaves the host, and keys never appear in any API.
      mentionKeys: room.mentionKeys instanceof Map ? Array.from(room.mentionKeys.entries()) : [],
      savedAt: Date.now(),
    });
    // Temp-file + rename so a crash mid-write never leaves a truncated room file.
    const file = roomFile(roomId);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, json);
    await fsp.rename(tmp, file);
  } catch {
    // Non-fatal — persistence is best-effort.
  } finally {
    persistInFlight.delete(roomId);
    if (persistDirty.delete(roomId)) saveRoomNow(roomId);
  }
}
function persistRoom(roomId) {
  if (persistTimers.has(roomId)) {
    return;
  }
  persistTimers.set(roomId, setTimeout(() => {
    persistTimers.delete(roomId);
    saveRoomNow(roomId);
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
  { code: 'MEMEWALL', title: 'Meme Wall', emoji: '🎭', prompts: ['Redraw a meme from memory', 'Draw a meme-worthy face', 'Your pet as a meme', 'Invent a brand-new meme'] },
  { code: 'VIBES', title: 'Aesthetic Board', emoji: '✨', prompts: ['Draw your current vibe', 'A moodboard in one color', 'Cozy things only', 'Sunset gradient anything'] },
  { code: 'OCCORNER', title: 'OC Corner', emoji: '🐲', prompts: ['Draw your OC — friends add theirs', 'Your OC in a new outfit', 'Two OCs team up', 'Give your OC a sidekick'] },
  { code: 'GRAFFITI', title: 'Graffiti Wall', emoji: '🧱', prompts: ['Tag the wall — keep it kind', 'Bubble-letter your name', 'Sticker-style doodles', 'Paint a mini mural piece'] },
  // The ONE public animation room. Everywhere else, the film strip is a
  // private-room setting (set_animation) — never on in public drawing rooms.
  { code: 'FLIPBOOK', title: 'Animation Studio', emoji: '🎬', animation: true, prompts: ['Animate a bouncing ball', 'Make a flower bloom frame by frame', 'A stick figure does a trick', 'Loop some rain falling'] },
  // The little-kids room: finger painting only. Wet canvas is always on,
  // smudging is the whole point, and there is NO chat (pre-readers).
  { code: 'FINGERS', title: 'Finger Paints', emoji: '🖐️', fingerPaint: true, prompts: ['Squish some colors together!', 'Paint with all ten fingers', 'Make the biggest rainbow smudge', 'Squishy squishy paint!'] },
  // Draw & Guess: one player draws a secret word, everyone else races to guess
  // it in chat. Always-on public game room; private rooms can flip it on too.
  { code: 'GUESS', title: 'Draw & Guess', emoji: '🎮', game: true, prompts: ['Guess what everyone is drawing!', 'Draw your word — no letters or numbers!', 'Race to guess it first'] },
  // Draw Phone: the telephone game. Everyone draws a secret prompt at once, then
  // passes it on — the next player guesses, the next draws the guess, and so on
  // until the whole silly chain reveals. Always-on public room; private rooms opt in.
  { code: 'PHONE', title: 'Draw Phone', emoji: '📞', phone: true, prompts: ['Draw the prompt, then pass it on!', 'Guess the drawing — then watch it drift', 'Telephone, but with doodles'] },
  // The Daily Challenge room: its prompt IS the day's challenge (see
  // server/dailyChallenges.js) and its canvas wipes fresh at UTC midnight —
  // the homepage's "come back tomorrow" loop. Wall posts made from this room
  // are auto-tagged into today's gallery.
  { code: 'DAILY', title: "Today's Challenge", emoji: '🗓️', daily: true, prompts: ['(daily challenge)'] },
  { code: 'KALEIDO', title: 'Kaleido Jam', emoji: '🌀', symmetry: 'quad', prompts: ['Build a shared mandala', 'Turn one line into a magical pattern', 'Make a creature from symmetry'] },
  { code: 'QUEST', title: 'Canvas Quests', emoji: '🧭', quests: true, prompts: ['Complete three creative missions together', 'Team up on today’s art quests', 'Every artist helps finish the quest'] },
  { code: 'ORCHSTRA', title: 'Paint Orchestra', emoji: '🎵', orchestra: true, prompts: ['Paint a song together', 'Make color sound like music', 'Jam with brushes and shapes'] },
];
const FEATURED_CODES = new Set(FEATURED_ROOMS.map((r) => r.code));
const FEATURED_INDEX = new Map(FEATURED_ROOMS.map((r, i) => [r.code, i]));
const ANIMATION_ROOM_CODES = new Set(FEATURED_ROOMS.filter((r) => r.animation).map((r) => r.code));
const FINGER_PAINT_CODES = new Set(FEATURED_ROOMS.filter((r) => r.fingerPaint).map((r) => r.code));
const GAME_ROOM_CODES = new Set(FEATURED_ROOMS.filter((r) => r.game).map((r) => r.code));
const PHONE_ROOM_CODES = new Set(FEATURED_ROOMS.filter((r) => r.phone).map((r) => r.code));

const SYMMETRY_MODES = Object.freeze({
  none: { mode: 'none', copies: 1 },
  mirror: { mode: 'mirror', copies: 2 },
  quad: { mode: 'quad', copies: 4 },
  radial: { mode: 'radial', copies: 8 },
});

function normalizeRoomSymmetry(value) {
  const mode = typeof value === 'string' ? value : value?.mode;
  return SYMMETRY_MODES[mode] || SYMMETRY_MODES.none;
}

function normalizeQuestState(value, roomId) {
  const daily = questSetFor(roomId);
  const currentValue = roomId === 'QUEST' && value?.setId !== daily.setId ? null : value;
  const ids = Array.isArray(currentValue?.missionIds) ? currentValue.missionIds.slice(0, 3) : daily.missions.map((mission) => mission.id);
  const valid = questMissions(ids);
  const missionIds = valid.length === 3 ? valid.map((mission) => mission.id) : daily.missions.map((mission) => mission.id);
  return {
    setId: typeof currentValue?.setId === 'string' ? currentValue.setId.slice(0, 48) : daily.setId,
    missionIds,
    completedIds: new Set(Array.isArray(currentValue?.completedIds) ? currentValue.completedIds.filter((id) => missionIds.includes(id)) : []),
    nominations: new Map(),
  };
}

function questPayload(room) {
  if (!room.quests) return null;
  const counts = {};
  for (const id of room.quests.missionIds) counts[id] = room.quests.nominations.get(id)?.size || 0;
  return {
    setId: room.quests.setId,
    missions: questMissions(room.quests.missionIds),
    completedIds: Array.from(room.quests.completedIds),
    counts,
    needed: Math.max(1, Math.floor(room.users.size / 2) + 1),
  };
}

function storybookPayload(room) {
  if (!room.storybook?.enabled) return null;
  return {
    ...room.storybook,
    pages: room.storybook.pages.map((page) => {
      const prompt = storybookPrompt(page.promptId);
      return { ...page, title: prompt.title, prompt: prompt.prompt };
    }),
  };
}

// ---- Shared animation frames -----------------------------------------------
// In an animation room the frames themselves are shared state (Google-Docs
// model): draw ops carry a frameId, frame add/remove/reorder/duration are
// relayed + persisted, and rejoiners replay the whole flipbook exactly like the
// mural. Caps REJECT at ingest (frame_full) rather than FIFO-trim, which would
// silently rot the earliest frames of an animation.
// Frame caps are a MEMORY budget, not just server disk: every client holds a
// full-res canvas per frame (~40MB at 4000x2500), so 12 frames ≈ 480MB on an
// iPad. Raise these only after frames move to the smaller animation doc size.
const MAX_ANIM_FRAMES_PUBLIC = Number(process.env.MAX_ANIM_FRAMES_PUBLIC || 8);
const MAX_ANIM_FRAMES_PRIVATE = Number(process.env.MAX_ANIM_FRAMES_PRIVATE || 8);
// Bound a single op's serialized weight (image ops embed dataURLs — a photo
// import is a few MB; nothing legitimate approaches this).
const MAX_OP_DATAURL_CHARS = Number(process.env.MAX_OP_DATAURL_CHARS || 8_000_000);
const MAX_DRAW_MESSAGE_CHARS = Number(process.env.MAX_DRAW_MESSAGE_CHARS || 128_000);
const MAX_DRAW_POINTS_PER_OP = Number(process.env.MAX_DRAW_POINTS_PER_OP || 2048);
const FRAME_OP_CAP = Number(process.env.FRAME_OP_CAP || 1500);
// Scenes break the per-room frame ceiling without breaking the memory budget:
// an animation room is one ~30-second SEGMENT — up to MAX_SCENES scenes of up
// to 8 frames each (20 x 8 = 160 frames) — but clients only ever HYDRATE one
// scene's frames, so RAM stays at a scene's worth. Scene creation is
// host-only — which also means the public FLIPBOOK playground (hostless by
// design) stays single-scene. Multi-segment "productions" (several linked
// rooms stitched into one film) build on top of this: see
// docs/animation-rooms-spec.md.
const MAX_SCENES = Number(process.env.MAX_SCENES || 20);
// A whole segment's op budget (protects the room file + join/fetch payloads;
// per-frame caps alone would allow 160 x 1500 = 240k ops ≈ 260MB JSON).
const MAX_ANIM_ROOM_OPS = Number(process.env.MAX_ANIM_ROOM_OPS || 40000);

function sanitizeFrames(list) {
  if (!Array.isArray(list)) return null;
  const frames = list
    .filter((f) => f && typeof f.id === 'string' && f.id.length <= 24)
    .map((f) => ({
      id: f.id,
      durationMs: Math.max(40, Math.min(2000, Number(f.durationMs) || 120)),
      sceneId: typeof f.sceneId === 'string' && f.sceneId.length <= 24 ? f.sceneId : null,
    }));
  return frames.length ? frames : null;
}

function sanitizeScenes(list) {
  if (!Array.isArray(list)) return null;
  const scenes = list
    .filter((s) => s && typeof s.id === 'string' && s.id.length <= 24)
    .map((s) => ({ id: s.id, name: typeof s.name === 'string' ? s.name.slice(0, 30) : 'Scene' }));
  return scenes.length ? scenes : null;
}

// The frame an op belongs to (legacy untagged ops live on the first frame).
function opFrameId(room, op) {
  return op.frameId || (room.frames[0] && room.frames[0].id) || 'f0';
}

// A scene's frames, in flat-array order (scene blocks stay contiguous).
function framesOfScene(room, sceneId) {
  return room.frames.filter((f) => f.sceneId === sceneId);
}

// Light scene metadata for pagers: ids, names, and per-frame timing (durations
// ride along so a stitched film export knows every frame's length up front).
function scenesMeta(room) {
  return room.scenes.map((s) => ({
    id: s.id,
    name: s.name,
    frames: framesOfScene(room, s.id).map((f) => ({ id: f.id, durationMs: f.durationMs })),
  }));
}

// ---- Productions: several segment rooms tied into one film -----------------
// A production is a tiny manifest — { id, title, segments: [roomCode…] } —
// stored under DATA_DIR/.productions. Segment rooms are ordinary private
// animation rooms (all moderation/host machinery untouched); the storyboard
// UI pages between them and the film export walks them client-side. Access
// model matches invites: knowing a segment's room code is being in the crew.
const PRODUCTIONS_DIR = join(DATA_DIR, '.productions');
const MAX_PRODUCTION_SEGMENTS = Number(process.env.MAX_PRODUCTION_SEGMENTS || 6);
const productions = new Map(); // id -> manifest (lazily loaded)

function productionFile(id) {
  return join(PRODUCTIONS_DIR, `${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 32)}.json`);
}

function getProduction(id) {
  if (!id) return null;
  if (!productions.has(id)) {
    try {
      const data = JSON.parse(readFileSync(productionFile(id), 'utf8'));
      if (data && Array.isArray(data.segments)) {
        productions.set(id, {
          id: String(data.id || id).slice(0, 32),
          title: typeof data.title === 'string' ? data.title.slice(0, 48) : 'Our Movie',
          segments: data.segments.map((c) => String(c).slice(0, 16)),
          createdAt: Number(data.createdAt) || Date.now(),
        });
      }
    } catch {
      return null;
    }
  }
  return productions.get(id) || null;
}

function saveProduction(production) {
  try {
    mkdirSync(PRODUCTIONS_DIR, { recursive: true });
    writeFileSync(productionFile(production.id), JSON.stringify(production));
  } catch {
    // best-effort — the in-memory manifest keeps the session working
  }
}

// The storyboard payload: per-segment title, live crew count, frame count and
// runtime, so the board reads like a call sheet ("Part 2 · 3 painting · 12s").
function productionSummary(production) {
  return {
    id: production.id,
    title: production.title,
    maxSegments: MAX_PRODUCTION_SEGMENTS,
    segments: production.segments.map((code, index) => {
      // LIVE rooms only — never getRoom() here, or every idle sibling segment
      // gets parsed off disk and pinned in the `rooms` map (the productionId
      // auto-close exemption then never evicts it). Dead segments report
      // disk-free defaults; their real title/frames restore when someone joins.
      const room = rooms.get(code);
      return {
        code,
        index,
        title: (room && room.title) || `Part ${index + 1}`,
        users: room ? room.users.size : 0,
        // Live crew chips for the storyboard — LIVE rooms only (never getRoom
        // an idle segment). Just the already-public {name,color}, capped.
        crew: room ? Array.from(room.users.values()).slice(0, 6).map((u) => ({ name: u.name, color: u.color })) : [],
        frames: room ? room.frames.length : 0,
        scenes: room ? room.scenes.length : 0,
        runtimeMs: room ? room.frames.reduce((sum, f) => sum + (f.durationMs || 120), 0) : 0,
      };
    }),
  };
}

// Fan a production update out to every LIVE member room of the film.
function broadcastProduction(production) {
  const message = { type: 'production_state', production: productionSummary(production) };
  for (const code of production.segments) {
    if (rooms.has(code)) {
      broadcast(code, message);
    }
  }
}

// One scene's shareable state: its frame list + the visible ops that live on
// those frames. This is what joins, scene switches, and resyncs deliver —
// never the whole movie, so client memory stays at one scene's worth.
function sceneHistoryMsg(room, sceneId) {
  const frames = framesOfScene(room, sceneId);
  const ids = new Set(frames.map((f) => f.id));
  return {
    type: 'history',
    sceneId,
    scenes: scenesMeta(room),
    frames,
    ops: visibleHistory(room).filter((op) => ids.has(opFrameId(room, op))),
  };
}

// Rebuild the per-frame op counts (after bulk history mutations: moderation
// removes, undo_clear restores, room load). O(history) — moderation-frequency.
function recountFrameOps(room) {
  const counts = new Map(room.frames.map((f) => [f.id, 0]));
  for (const op of room.history) {
    const fid = opFrameId(room, op);
    counts.set(fid, (counts.get(fid) || 0) + 1);
  }
  room.frameOpCounts = counts;
}

// The prompt shown today for a featured room (deterministic daily rotation, UTC).
function dailyPromptFor(featured) {
  if (!featured || !featured.prompts || !featured.prompts.length) return null;
  // The DAILY room's prompt is the day's challenge itself. Evaluated ONCE — a
  // call pair straddling midnight would pair one day's emoji with another's prompt.
  if (featured.daily) {
    const c = dailyChallenge();
    return `${c.emoji} ${c.prompt}`;
  }
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
    // Frame AND scene ids mint from the SAME counter (`f<opSeq>` / `s<opSeq>`)
    // and can outlive the highest history opId (blank frames, per-frame
    // clears) — scan them too or a restart could mint a duplicate id.
    for (const f of Array.isArray(saved.frames) ? saved.frames : []) {
      const m = /^f(\d+)$/.exec((f && f.id) || '');
      if (m && Number(m[1]) > opSeq) opSeq = Number(m[1]);
    }
    for (const s of Array.isArray(saved.scenes) ? saved.scenes : []) {
      const m = /^s(\d+)$/.exec((s && s.id) || '');
      if (m && Number(m[1]) > opSeq) opSeq = Number(m[1]);
    }
    rooms.set(roomId, {
      code: roomId,
      users: new Map(),
      history: saved.history,
      lastCleared: null,
      sheetId: saved.sheetId,
      // Featured anchor rooms (MAIN, DOODLE, …) are communal and must never be
      // owned. An older build let the first signed-in visitor claim them, which
      // host-gated Clear and let the mural stack up un-wipeable — strip any stale
      // owner/co-hosts on load so they self-heal on the next deploy.
      ownerProfileId: FEATURED_CODES.has(roomId) ? null : saved.ownerProfileId,
      coHosts: FEATURED_CODES.has(roomId) ? [] : saved.coHosts,
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
      chat: saved.chat || [], // recent chat buffer (late-joiner context, persisted)
      chatSeq: 0, // per-room chat message id counter (backfilled below; persisted)
      watchers: new Set(), // elected client ids running the in-browser watcher
      spectators: new Set(), // read-only homepage viewers (not counted as users)
      // Ephemeral "who's on which cel" presence for animation rooms: userId ->
      // {sceneId, frameId, ts}. Never persisted (like cursors/spectators),
      // bounded by MAX_ROOM_USERS, cleared on disconnect + overwritten on hop.
      presence: new Map(),
      modLog: [], // recent moderation actions (in-memory, capped)
      // name(lower) -> capability key for cross-room mention watching (persisted).
      mentionKeys: new Map(Array.isArray(saved.mentionKeys) ? saved.mentionKeys : []),
      userSeconds: saved.userSeconds || 0, // cumulative engagement, for auto-close TTL
      wetCanvas: !!saved.wetCanvas, // wet-canvas mixing toggle (persisted)
      customPrompt: saved.customPrompt, // theme-vote winner; beats the daily prompt
      symmetry: roomId === 'KALEIDO' ? SYMMETRY_MODES.quad : normalizeRoomSymmetry(saved.symmetry),
      orchestraEnabled: roomId === 'ORCHSTRA',
      quests: roomId === 'QUEST' || saved.quests ? normalizeQuestState(saved.quests, roomId) : null,
      storybook: saved.storybook || null,
      remixSource: saved.remixSource || null,
      vote: null, // open theme vote: { options, votes: {userId: 0|1|2}, endsAt }
      voteTimer: null, // the vote-close timeout (cleared with the room)
      lastVoteAt: 0, // vote_start cooldown anchor (in-memory)
      // Shared-animation state. Every room carries a frames list (legacy
      // untagged ops live on frames[0]) grouped into scenes; only
      // animation-enabled rooms may grow either. Public rooms can NEVER opt
      // in — only FLIPBOOK ships the strip.
      frames: sanitizeFrames(saved.frames) || [{ id: 'f0', durationMs: 120, sceneId: null }],
      scenes: sanitizeScenes(saved.scenes) || [{ id: 's0', name: 'Scene 1' }],
      animationEnabled: ANIMATION_ROOM_CODES.has(roomId) || (audience !== 'kid_safe' && !!saved.animation),
      // Finger-paint mode: smudge allowed despite kid_safe, chat disabled,
      // wet canvas on. Only the featured FINGERS room carries it.
      fingerPaint: FINGER_PAINT_CODES.has(roomId),
      // Draw & Guess: the GUESS room always has it; private rooms opt in via
      // set_game. `game` is the ephemeral live round (never persisted).
      gameEnabled: GAME_ROOM_CODES.has(roomId) || (audience !== 'kid_safe' && !!saved.game),
      game: null, // live round: { phase, drawerId, word, endsAt, scores, guessed, ... }
      gameTimers: null, // { round, hint, intermission } setTimeout handles
      // Daily Challenge: which challenge date this room's canvas belongs to
      // (only meaningful for DAILY; drives the derived midnight wipe).
      dailyDate: saved.dailyDate || null,
      // Draw Phone (telephone): DRAWPHONE is always on; private rooms opt in via
      // set_phone. `phone` is the ephemeral live game (books/rounds; never persisted).
      phoneEnabled: PHONE_ROOM_CODES.has(roomId) || (audience !== 'kid_safe' && !!saved.phone),
      phone: null, // live game: { phase, round, totalRounds, players, books, ... }
      phoneTimers: null, // { round } setTimeout handle for the round deadline
      // Which multi-room production (film) this room is a segment of, if any.
      productionId: saved.productionId || null,
      lastClearedFrameId: null, // which frame the in-memory undo-clear backup belongs to
      lastActivity: Date.now(),
    });
    const created = rooms.get(roomId);
    // Storybooks reuse the paged animation scene model: one scene is one page.
    // Preserve any pre-existing first scene/art, then add blank pages up to four.
    if (saved.storybook?.enabled) enableStorybookRoom(created);
    // Backfill: every frame belongs to a real scene (legacy files predate
    // scenes; a frame whose scene was deleted folds into the first one).
    const sceneIds = new Set(created.scenes.map((s) => s.id));
    for (const frame of created.frames) {
      if (!frame.sceneId || !sceneIds.has(frame.sceneId)) {
        frame.sceneId = created.scenes[0].id;
      }
    }
    // Backfill chat ids (tapbacks/replies key on them): legacy lines predate
    // ids. Resume the counter past the highest seen so ids never collide.
    let chatSeq = Number(saved.chatSeq) || 0;
    for (const line of created.chat) {
      if (typeof line.id === 'number' && Number.isFinite(line.id)) chatSeq = Math.max(chatSeq, line.id);
      else line.id = ++chatSeq;
    }
    created.chatSeq = chatSeq;
    recountFrameOps(created);
  }
  return rooms.get(roomId);
}

function enableStorybookRoom(room) {
  room.animationEnabled = true;
  while (room.scenes.length < 4) {
    room.opSeq += 1;
    const sceneId = `s${room.opSeq}`;
    room.scenes.push({ id: sceneId, name: `Page ${room.scenes.length + 1}` });
    room.opSeq += 1;
    room.frames.push({ id: `f${room.opSeq}`, durationMs: 120, sceneId });
  }
  if (!room.storybook?.enabled || !Array.isArray(room.storybook.pages)) {
    room.storybook = defaultStorybook(room.scenes.slice(0, 4));
  }
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
    // Animation is a per-room capability: always on for FLIPBOOK, always OFF
    // for every other public room (re-asserted each boot so it can't drift).
    room.animationEnabled = ANIMATION_ROOM_CODES.has(f.code);
    room.fingerPaint = FINGER_PAINT_CODES.has(f.code);
    room.gameEnabled = GAME_ROOM_CODES.has(f.code);
    room.phoneEnabled = PHONE_ROOM_CODES.has(f.code);
    room.symmetry = f.symmetry ? normalizeRoomSymmetry(f.symmetry) : SYMMETRY_MODES.none;
    room.orchestraEnabled = !!f.orchestra;
    room.quests = f.quests ? (room.quests || normalizeQuestState(null, f.code)) : null;
    if (room.fingerPaint) {
      room.wetCanvas = true; // finger paints are ALWAYS wet — that's the toy
    }
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
    if (room.voteTimer) { clearTimeout(room.voteTimer); room.voteTimer = null; }
    clearGameTimers(room); // never leave a Draw & Guess round timer firing on a closed room
    clearPhoneTimers(room); // same for a Draw Phone round/intermission timer
    dropRoomPhonePages(room); // free any Draw Phone page images
    dropRoomTracePhoto(room); // free any uploaded trace photo when the room dies
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
    // Production segments are chapters of someone's FILM — an idle Part 3
    // getting reaped would put a hole in the movie. They outlive the sweep,
    // but only while the film still exists: an orphaned segment (manifest lost)
    // ages out normally instead of leaking forever.
    if (room.productionId && getProduction(room.productionId)) return;
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
      if (data.productionId && getProduction(data.productionId)) continue; // only live films are exempt
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

// ---- Daily Challenge rollover ----------------------------------------------
// The DAILY room's canvas belongs to ONE challenge date, stamped on the room
// and persisted (room.dailyDate). Whenever the stamp disagrees with today the
// canvas is wiped and the fresh prompt pushed — DERIVED from the date exactly
// like the prompt itself, so a restart or downtime spanning midnight can never
// leave yesterday's mural under today's challenge (deploys restart this
// server!). Idempotent + cheap (one string compare), so it runs at boot, on
// every DAILY join, from /api/daily, and on a once-a-minute tick.
function ensureDailyFresh() {
  const room = rooms.get('DAILY');
  if (!room) return;
  const fresh = dailyChallenge();
  if (room.dailyDate === fresh.date) return;
  room.dailyDate = fresh.date;
  room.customPrompt = null; // a theme vote never outlives the day
  room.history = [];
  recountFrameOps(room);
  room.sheetId = null;
  room.lastCleared = null;
  room.lastClearedFrameId = null;
  room.lastClearedSheet = null;
  // Yesterday's ops are gone — stale moderation state on them is pure liability
  // (recycled opIds would silently hide innocent new-day strokes).
  room.hiddenOpIds.clear();
  room.flaggedOps.clear();
  broadcast('DAILY', { type: 'clear', userId: 'system', name: 'Daily Challenge', gameRound: true });
  broadcast('DAILY', { type: 'sheet', sheetId: null });
  // vote_result is the client's existing "here's the new prompt" path (toast +
  // un-hidden chip) — reuse it rather than inventing a new message type.
  broadcast('DAILY', { type: 'vote_result', prompt: `${fresh.emoji} ${fresh.prompt}`, counts: [0, 0, 0] });
  persistRoom('DAILY');
}
ensureDailyFresh(); // boot: wipe a stale canvas loaded from disk (restart spanning midnight)
const dailyRolloverTimer = setInterval(ensureDailyFresh, 60_000);
if (dailyRolloverTimer.unref) dailyRolloverTimer.unref();

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
  // Only the disabled adult tier skips image scanning. Public AND private rooms
  // elect a capable client to watch the canvas when one is present.
  if (room.audience === 'adult_18') {
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
  // Tell the room whether a watcher is currently active (drives the client's
  // "a grown-up watcher isn't active right now" safety note), only on change.
  const watched = room.watchers.size > 0;
  if (room._watched !== watched) {
    room._watched = watched;
    broadcast(room.code, { type: 'room_watch_state', watched });
  }
}

const ANIMAL_NAMES = [
  'Fox', 'Otter', 'Panda', 'Robin', 'Koala', 'Tiger', 'Bunny', 'Whale',
  'Lynx', 'Finch', 'Newt', 'Wren', 'Yak', 'Lark', 'Seal', 'Crow',
];
const GUEST_ADJECTIVES = [
  'Neon', 'Pixel', 'Turbo', 'Cosmic', 'Mango', 'Disco', 'Ninja', 'Doodle',
  'Retro', 'Zesty', 'Lucky', 'Shadow', 'Crispy', 'Mellow', 'Rocket', 'Velvet',
  'Snazzy', 'Breezy', 'Frosty', 'Groovy', 'Sunny', 'Wobbly', 'Zippy', 'Nova',
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

// Fun "Adjective Animal" guest names ("Neon Fox", "Snazzy Bunny"). Retries a few
// times to dodge anyone already in the room, then falls back to a digit suffix.
// Longest combo is 13 chars — comfortably inside the 20-char rename cap.
function guestNameFor(room) {
  const taken = new Set(Array.from(room.users.values()).map((u) => u.name));
  for (let i = 0; i < 10; i += 1) {
    const name = `${pick(GUEST_ADJECTIVES)} ${pick(ANIMAL_NAMES)}`;
    if (!taken.has(name)) return name;
  }
  return `${pick(GUEST_ADJECTIVES)} ${pick(ANIMAL_NAMES)}${Math.floor(Math.random() * 10)}`;
}

// A user hosts a room if they're the owner (the first signed-in grown-up to
// claim it) or a promoted co-host. Anonymous users (no profileId) never host.
function isHost(room, user) {
  if (!user) return false;
  // Guest host: the first person in an ownerless PRIVATE room moderates it, so a
  // private room is never left with nobody able to mute/kick/hide/lock.
  if (!room.ownerProfileId && room.hostUserId && room.hostUserId === user.id) return true;
  if (!user.profileId) return false;
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

// The recent-chat catch-up sent to anyone joining (or spectating) a room, so
// they see who's been talking. Capped to the last 50. Projection rules:
// profileId stays server-side, and tapback membership lists (gameKeys) reduce
// to COUNTS — who reacted is never exposed, only how many.
function chatHistoryMsg(room) {
  return {
    type: 'chat_history',
    messages: (room.chat || []).slice(-50).map((c) => ({
      msgId: c.id,
      user: c.user,
      message: c.message,
      ts: c.ts,
      ...(c.system ? { system: true } : {}),
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      ...(c.reactions
        ? { reactions: Object.fromEntries(Object.entries(c.reactions).map(([e, l]) => [e, l.length])) }
        : {}),
    })),
  };
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
  // Read-only homepage viewers see the live mural too, but never draw/count.
  // ALLOWLIST, not blocklist: spectators get the mural (ops, clears, sheet
  // swaps) and moderation history rebuilds — nothing else. Rosters, cursors,
  // chat, hype, renames and every future message type stay inside the room by
  // default, so a new social feature can never leak names to spectators.
  // Animation rooms: spectators watch the FIRST frame only (mirrors the join
  // filter) — ops/clears for other frames would smear onto their one canvas.
  if (room.spectators && room.spectators.size) {
    const t = message.type;
    if (t !== 'op' && t !== 'clear' && t !== 'sheet' && t !== 'history') return;
    if (room.animationEnabled) {
      // A history rebuild carries every frame's ops — a spectator's single
      // canvas would smear them together. Skip it; the tile catches up on hop.
      if (t === 'history') return;
      const firstId = room.frames[0] && room.frames[0].id;
      if (t === 'op' && message.op && opFrameId(room, message.op) !== firstId) return;
      if (t === 'clear' && message.frameId && message.frameId !== firstId) return;
    }
    room.spectators.forEach((sws) => {
      if (sws.readyState === 1) sws.send(data);
    });
  }
}

// ---- Draw & Guess game engine ---------------------------------------------
// One drawer per round gets a secret word; everyone else races to type it in
// chat. The WORD is the only secret — draw ops relay as normal ops, so replay
// stays deterministic. All live state is on room.game (ephemeral, NEVER
// persisted — like room.vote); timers on room.gameTimers.
const GAME_ROUND_MS = 75_000; // drawing time per round
const GAME_INTERMISSION_MS = 6_000; // reveal + scoreboard pause between rounds
const GAME_MIN_PLAYERS = 2;
const GAME_MATCH_ROUNDS = 5; // rounds per match — then the podium + score reset
const GAME_PODIUM_MS = 11_000; // podium celebration pause before the next match

function normalizeGuess(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
// Space-stripped form for the LEAK guard: "c a t" / "c-a-t" / "cats" all
// collapse so a message can't smuggle the word past the suppressor.
function squishGuess(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
// Stable scoring identity: a signed-in player keeps their score across
// reconnects (session ids are minted per socket); anonymous falls back to the
// session id.
function gameKey(user) {
  return user.profileId ? `pb_${user.profileId}` : user.id;
}
function gamePlayers(room) {
  return [...room.users.values()]; // join order (Map preserves insertion) = drawer rotation
}
function clearGameTimers(room) {
  if (!room.gameTimers) return;
  for (const t of Object.values(room.gameTimers)) if (t) clearTimeout(t);
  room.gameTimers = null;
}
// Length + revealed hint letters as "_ a _ _" (spaces preserved).
function maskWord(word, revealed) {
  return word.split('').map((ch, i) => (ch === ' ' ? '  ' : revealed.has(i) ? ch : '_')).join(' ');
}
// The PUBLIC snapshot — never carries the word for guessers.
function publicGame(room) {
  const g = room.game;
  if (!g) return null;
  const scores = gamePlayers(room)
    .map((u) => ({ id: u.id, name: u.name, score: (g.scores && g.scores[gameKey(u)]) || 0, guessed: g.guessed ? g.guessed.has(gameKey(u)) : false }))
    .sort((a, b) => b.score - a.score);
  return {
    phase: g.phase,
    roundNo: g.roundNo,
    drawerId: g.drawerId,
    drawerName: g.drawerName,
    endsAt: g.endsAt,
    wordMask: g.wordMask || '',
    wordLen: g.word ? g.word.length : 0,
    scores,
  };
}
function broadcastGame(roomId) {
  const room = rooms.get(roomId);
  if (room) broadcast(roomId, { type: 'game_state', game: publicGame(room) });
}
function pushGameChat(room, roomId, message, color) {
  const line = { id: ++room.chatSeq, user: { id: 'system', name: 'Draw & Guess', color: color || '#7c3aed' }, message, ts: Date.now(), system: true };
  room.chat.push(line);
  if (room.chat.length > CHAT_BUFFER_MAX) room.chat.splice(0, room.chat.length - CHAT_BUFFER_MAX);
  broadcast(roomId, { type: 'chat', msgId: line.id, user: line.user, message, ts: line.ts, system: true });
}

function startGameRound(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameEnabled) return;
  clearGameTimers(room);
  const players = gamePlayers(room);
  if (players.length < GAME_MIN_PLAYERS) {
    room.game = { phase: 'waiting', roundNo: room.game ? room.game.roundNo : 0, scores: (room.game && room.game.scores) || {}, guessed: new Set(), drawerId: null, drawerName: '', word: null, wordMask: '', endsAt: 0 };
    broadcastGame(roomId);
    return;
  }
  // Rotate drawer round-robin by join order (prev not found → first player).
  const prevIdx = players.findIndex((u) => u.id === (room.game && room.game.drawerId));
  const drawer = players[(prevIdx + 1) % players.length];
  const word = pickWordChoices(Math.random, 1)[0];
  const now = Date.now();
  room.game = {
    phase: 'playing',
    roundNo: (room.game ? room.game.roundNo : 0) + 1,
    drawerId: drawer.id,
    drawerKey: gameKey(drawer), // stable identity for the drawer's per-guess bonus
    drawerName: drawer.name,
    word,
    revealed: new Set(),
    wordMask: maskWord(word, new Set()),
    endsAt: now + GAME_ROUND_MS,
    scores: (room.game && room.game.scores) || {},
    guessed: new Set(),
  };
  // Blank the canvas for the fresh drawing (reuse the clear semantics). Reset
  // the undo-clear backup too, or "Bring it back" would resurrect a previous
  // round's drawing onto the live canvas.
  room.history = [];
  recountFrameOps(room);
  room.sheetId = null;
  room.lastCleared = null;
  room.lastClearedFrameId = null;
  room.lastClearedSheet = null;
  broadcast(roomId, { type: 'clear', userId: 'system', name: 'Draw & Guess', gameRound: true });
  broadcast(roomId, { type: 'sheet', sheetId: null });
  // Secret word to the DRAWER ONLY (send-to-one); everyone else gets guesser.
  if (drawer.ws.readyState === 1) {
    drawer.ws.send(JSON.stringify({ type: 'game_role', role: 'drawer', word, roundNo: room.game.roundNo }));
  }
  broadcast(roomId, { type: 'game_role', role: 'guesser', roundNo: room.game.roundNo }, drawer.id);
  pushGameChat(room, roomId, `${drawer.name} is drawing! Guess the word.`, '#7c3aed');
  broadcastGame(roomId);
  room.gameTimers = {
    round: setTimeout(() => endGameRound(roomId, 'timeup'), GAME_ROUND_MS),
    hint: setTimeout(() => revealHint(roomId), Math.round(GAME_ROUND_MS * 0.55)),
    intermission: null,
  };
  persistRoom(roomId); // the blanked canvas must survive a restart mid-round
}

function revealHint(roomId) {
  const room = rooms.get(roomId);
  const g = room && room.game;
  if (!g || g.phase !== 'playing' || !g.word) return;
  const candidates = [];
  for (let i = 0; i < g.word.length; i += 1) {
    if (g.word[i] !== ' ' && !g.revealed.has(i)) candidates.push(i);
  }
  if (candidates.length <= 1) return; // never reveal the last letter
  g.revealed.add(candidates[Math.floor(Math.random() * candidates.length)]);
  g.wordMask = maskWord(g.word, g.revealed);
  broadcastGame(roomId);
}

function endGameRound(roomId, reason) {
  const room = rooms.get(roomId);
  const g = room && room.game;
  if (!g || g.phase !== 'playing') return;
  clearGameTimers(room);
  g.phase = 'intermission';
  broadcast(roomId, { type: 'game_end', word: g.word, reason, game: publicGame(room) });
  // Every MATCH_ROUNDS rounds the match ends on a podium: top three by
  // cumulative score get their moment (confetti client-side), then scores
  // reset and a fresh match begins. Turns an endless round-carousel into
  // something you can WIN — and a reason to stay for "one more match".
  const matchOver = g.roundNo >= GAME_MATCH_ROUNDS;
  let pauseMs = GAME_INTERMISSION_MS;
  if (matchOver) {
    const standings = gamePlayers(room)
      .map((u) => ({ name: u.name, score: (g.scores && g.scores[gameKey(u)]) || 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (standings.length && standings[0].score > 0) {
      broadcast(roomId, { type: 'game_podium', standings, rounds: g.roundNo });
      pushGameChat(room, roomId, `🏆 Match over — ${standings[0].name} takes the crown with ${standings[0].score} points!`, '#b45309');
      pauseMs = GAME_PODIUM_MS;
    }
    g.roundNo = 0;
    g.scores = {};
    pushGameChat(room, roomId, `The word was "${g.word}". New match starting…`, '#7c3aed');
  } else {
    pushGameChat(room, roomId, `The word was "${g.word}". Next round starting…`, '#7c3aed');
  }
  broadcastGame(roomId);
  room.gameTimers = { round: null, hint: null, intermission: setTimeout(() => startGameRound(roomId), pauseMs) };
}

function stopGame(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearGameTimers(room);
  room.game = null;
  broadcast(roomId, { type: 'game_state', game: null, stopped: reason || true });
}

// Auto-run the featured game room / opted-in private rooms: start when a 2nd
// player arrives and the game is idle; otherwise show a "waiting" HUD so even a
// solo joiner sees the game exists and knows a friend is needed.
function maybeStartGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameEnabled) return;
  const enough = gamePlayers(room).length >= GAME_MIN_PLAYERS;
  const idle = !room.game || room.game.phase === 'waiting';
  if (enough && idle) {
    startGameRound(roomId);
  } else if (!enough && (!room.game || room.game.phase !== 'waiting')) {
    room.game = { phase: 'waiting', roundNo: room.game ? room.game.roundNo : 0, scores: (room.game && room.game.scores) || {}, guessed: new Set(), drawerId: null, drawerName: '', word: null, wordMask: '', endsAt: 0 };
    broadcastGame(roomId);
  }
}

// End the round early once every remaining guesser has solved it. Called both
// on a correct guess AND when a not-yet-guessed guesser leaves (their departure
// can complete the "everyone guessed" condition).
function checkAllGuessed(roomId) {
  const room = rooms.get(roomId);
  const g = room && room.game;
  if (!g || g.phase !== 'playing') return;
  const guessers = gamePlayers(room).filter((u) => u.id !== g.drawerId);
  if (guessers.length > 0 && guessers.every((u) => g.guessed.has(gameKey(u)))) {
    endGameRound(roomId, 'allguessed');
  }
}

// A chat line during a live round. Returns 'correct' | 'spoiler' | null.
//  - 'correct': an exact/token match from a fresh guesser → scored + announced.
//  - 'spoiler': the message CONTAINS the word (letter-spaced "c a t", a
//    superstring "cats", or the drawer/an already-correct guesser typing it) →
//    suppressed with no score, so the answer never reaches the room.
//  - null: ordinary chat → broadcast normally.
function handleGuess(room, roomId, user, rawMessage) {
  const g = room.game;
  if (!g || g.phase !== 'playing' || !g.word) return null;
  const guess = normalizeGuess(rawMessage);
  const target = normalizeGuess(g.word);
  if (!target) return null;
  const exact = guess === target || guess.split(' ').includes(target) || (target.includes(' ') && guess.includes(target));
  // Leak guard: any message whose letters contain the word (spaces stripped)
  // must not be echoed, even if it isn't an exact scoring match.
  const targetSquished = squishGuess(g.word);
  const contains = !!targetSquished && squishGuess(rawMessage).includes(targetSquished);
  if (!exact && !contains) return null;
  const gk = gameKey(user);
  // Not a fresh scoring guess (drawer, already-correct, or a non-exact
  // word-containing message) → suppress it, award nothing.
  if (!exact || user.id === g.drawerId || g.guessed.has(gk)) return 'spoiler';
  const frac = Math.max(0, Math.min(1, (g.endsAt - Date.now()) / GAME_ROUND_MS));
  const points = 50 + Math.round(50 * frac);
  g.scores[gk] = (g.scores[gk] || 0) + points;
  if (g.drawerKey) g.scores[g.drawerKey] = (g.scores[g.drawerKey] || 0) + 25; // drawer earns per correct guesser
  g.guessed.add(gk);
  broadcast(roomId, { type: 'game_correct', userId: user.id, name: user.name, points });
  pushGameChat(room, roomId, `${user.name} guessed it! +${points}`, '#16a34a');
  broadcastGame(roomId);
  checkAllGuessed(roomId);
  return 'correct';
}

// ---- Draw Phone (telephone / Gartic) --------------------------------------
// Everyone gets a secret prompt "book". Each round the books rotate one seat
// around the circle, alternating DRAW (draw the text at the top of your held
// book) and GUESS (describe the drawing at the top). After N rounds the books
// reveal, showing the drift. Unlike Draw & Guess this uses NO shared canvas —
// each player draws PRIVATELY on their own local canvas and submits a finished
// PNG page, so draw ops are suppressed while a game runs (see the `op` case).
// All live state is on room.phone (ephemeral, NEVER persisted); the round timer
// on room.phoneTimers. Only room.phoneEnabled (the opt-in) persists.
const PHONE_MIN_PLAYERS = 3;
const PHONE_MAX_PLAYERS = 8;
const PHONE_MAX_ROUNDS = 8; // books never grow past this even with a huge room
const PHONE_DRAW_MS = 80_000; // draw-a-page time per round
const PHONE_GUESS_MS = 45_000; // describe-the-drawing time per round
const PHONE_INTERMISSION_MS = 45_000; // reveal pause before a public room re-starts
const PHONE_GUESS_MAX = 120; // per-guess character cap (chat caps at 300)

function clearPhoneTimers(room) {
  if (!room.phoneTimers) return;
  for (const t of Object.values(room.phoneTimers)) if (t) clearTimeout(t);
  room.phoneTimers = null;
}
// True while a Draw Phone game owns the canvas (pages are private). During these
// phases the shared canvas is OFF: draw ops, clears, restores, sheet-swaps and
// live cursors are all suppressed so one player can't see or wreck another's page.
function phoneActive(room) {
  const p = room && room.phone;
  return !!p && (p.phase === 'starting' || p.phase === 'drawing' || p.phase === 'guessing');
}
// The frozen players who are still connected (by stable game key), in seat order.
function phonePresentKeys(room) {
  if (!room.phone) return [];
  const live = new Set([...room.users.values()].map(gameKey));
  return room.phone.players.filter((k) => live.has(k));
}
function phoneUniquePresent(room) {
  return new Set([...room.users.values()].map(gameKey)).size;
}
// Which book (index) a seat holds this round: books shift one seat per round.
function phoneBookForSeat(seat, round, n) {
  return ((seat - round) % n + n) % n;
}
// PUBLIC snapshot — no page contents, no raw keys (names only).
function publicPhone(room) {
  const p = room.phone;
  if (!p) return null;
  return {
    phase: p.phase,
    round: p.round,
    totalRounds: p.totalRounds,
    deadline: p.deadline || 0,
    players: p.players.map((k) => p.names[k] || 'Someone'),
    submittedCount: p.submitted ? p.submitted.size : 0,
    // While waiting/revealing there's no frozen roster yet — show how many are
    // actually in the room (that's the "need 3 to start" count).
    presentCount: (p.phase === 'waiting' || p.phase === 'reveal')
      ? phoneUniquePresent(room)
      : phonePresentKeys(room).length,
    minPlayers: PHONE_MIN_PLAYERS,
    hostControlled: !PHONE_ROOM_CODES.has(room.code),
  };
}
function broadcastPhone(roomId) {
  const room = rooms.get(roomId);
  if (room) broadcast(roomId, { type: 'phone_state', phone: publicPhone(room) });
}
function pushPhoneChat(room, roomId, message) {
  const line = { id: ++room.chatSeq, user: { id: 'system', name: 'Draw Phone', color: '#0ea5e9' }, message, ts: Date.now(), system: true };
  room.chat.push(line);
  if (room.chat.length > CHAT_BUFFER_MAX) room.chat.splice(0, room.chat.length - CHAT_BUFFER_MAX);
  broadcast(roomId, { type: 'chat', msgId: line.id, user: line.user, message, ts: line.ts, system: true });
}
// Park a "need more players" waiting HUD (mirrors Draw & Guess's waiting state).
function phoneWaiting(room) {
  room.phone = { phase: 'waiting', round: 0, totalRounds: 0, players: [], names: {}, books: [], deadline: 0, submitted: new Set() };
}

function startPhoneGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.phoneEnabled) return;
  clearPhoneTimers(room);
  // Freeze the roster (unique by stable key, capped, join order) at kickoff.
  const seen = new Set();
  const players = [];
  const names = {};
  for (const u of room.users.values()) {
    const k = gameKey(u);
    if (seen.has(k)) continue;
    seen.add(k);
    players.push(k);
    names[k] = u.name;
    if (players.length >= PHONE_MAX_PLAYERS) break;
  }
  if (players.length < PHONE_MIN_PLAYERS) {
    phoneWaiting(room);
    broadcastPhone(roomId);
    return;
  }
  const totalRounds = Math.min(players.length, PHONE_MAX_ROUNDS);
  const books = players.map((k) => {
    const seed = pickWordChoices(Math.random, 1)[0];
    return { ownerKey: k, ownerName: names[k], pages: [{ type: 'prompt', by: 'system', byName: 'Prompt', content: seed }] };
  });
  room.phone = { phase: 'starting', round: 0, totalRounds, players, names, books, deadline: 0, submitted: new Set() };
  // The shared canvas is off for the whole game — clear its server state so any
  // pre-game doodles don't resurrect for a late joiner (ops are dropped while
  // the game runs; see the `op` case).
  room.history = [];
  recountFrameOps(room);
  room.sheetId = null;
  room.lastCleared = null;
  room.lastClearedFrameId = null;
  room.lastClearedSheet = null;
  pushPhoneChat(room, roomId, `Draw Phone! ${players.length} playing — draw your secret prompt, then pass it on. 📞`);
  startPhoneRound(roomId);
}

function startPhoneRound(roomId) {
  const room = rooms.get(roomId);
  const p = room && room.phone;
  if (!p) return;
  const n = p.players.length;
  p.phase = p.round % 2 === 0 ? 'drawing' : 'guessing';
  p.submitted = new Set();
  const dur = p.phase === 'drawing' ? PHONE_DRAW_MS : PHONE_GUESS_MS;
  p.roundStartedAt = Date.now();
  p.deadline = p.roundStartedAt + dur;
  // Blank every player's local canvas for a fresh page (drawing rounds only).
  // The client `clear` handler already suppresses its banner on `gameRound`.
  if (p.phase === 'drawing') {
    broadcast(roomId, { type: 'clear', userId: 'system', name: 'Draw Phone', gameRound: true });
    broadcast(roomId, { type: 'sheet', sheetId: null });
  }
  // Hand each present player their PRIVATE task: the top page of their held book.
  for (const u of room.users.values()) {
    const seat = p.players.indexOf(gameKey(u));
    if (seat < 0) continue; // spectator / late joiner — watches, no task
    const book = p.books[phoneBookForSeat(seat, p.round, n)];
    const top = book.pages[book.pages.length - 1];
    const task = p.phase === 'drawing'
      ? { type: 'phone_task', phase: 'drawing', round: p.round, totalRounds: p.totalRounds, deadline: p.deadline, prompt: String(top.content || '') }
      : { type: 'phone_task', phase: 'guessing', round: p.round, totalRounds: p.totalRounds, deadline: p.deadline, image: String(top.content || '') };
    if (u.ws.readyState === 1) u.ws.send(JSON.stringify(task));
  }
  broadcastPhone(roomId);
  clearPhoneTimers(room);
  room.phoneTimers = { round: setTimeout(() => fillMissingAndAdvance(roomId), dur) };
  persistRoom(roomId);
}

// End of round: any book missing this round's page (holder absent or idle) gets
// a placeholder, then advance — to the next round or the reveal.
function fillMissingAndAdvance(roomId) {
  const room = rooms.get(roomId);
  const p = room && room.phone;
  if (!p || (p.phase !== 'drawing' && p.phase !== 'guessing')) return;
  clearPhoneTimers(room);
  const n = p.players.length;
  const want = p.round + 2; // pages a book should have AFTER this round
  for (let seat = 0; seat < n; seat += 1) {
    const book = p.books[phoneBookForSeat(seat, p.round, n)];
    if (book.pages.length >= want) continue;
    const holderKey = p.players[seat];
    if (p.phase === 'drawing') {
      book.pages.push({ type: 'draw', by: holderKey, byName: p.names[holderKey] || '?', content: null, skipped: true });
    } else {
      book.pages.push({ type: 'guess', by: holderKey, byName: p.names[holderKey] || '?', content: '(ran out of time)', skipped: true });
    }
  }
  p.round += 1;
  if (p.round >= p.totalRounds) {
    startPhoneReveal(roomId);
  } else {
    startPhoneRound(roomId);
  }
}

// Advance early once every present player has submitted this round.
function checkPhoneRoundComplete(roomId) {
  const room = rooms.get(roomId);
  const p = room && room.phone;
  if (!p || (p.phase !== 'drawing' && p.phase !== 'guessing')) return;
  const present = phonePresentKeys(room);
  if (present.length && present.every((k) => p.submitted.has(k))) {
    fillMissingAndAdvance(roomId);
  }
}

function startPhoneReveal(roomId) {
  const room = rooms.get(roomId);
  const p = room && room.phone;
  if (!p) return;
  clearPhoneTimers(room);
  p.phase = 'reveal';
  p.deadline = 0;
  const books = p.books.map((b) => ({
    ownerName: b.ownerName,
    pages: b.pages.map((pg) => ({ type: pg.type, byName: pg.byName, content: pg.content, skipped: !!pg.skipped })),
  }));
  broadcast(roomId, { type: 'phone_reveal', books });
  broadcastPhone(roomId);
  pushPhoneChat(room, roomId, 'The books are in! See how your prompt drifted. 🎉');
  // Public rooms auto-start a fresh game after a reading pause; private rooms
  // wait for the host to hit "Play again".
  if (PHONE_ROOM_CODES.has(roomId)) {
    room.phoneTimers = { round: setTimeout(() => maybePhoneStart(roomId), PHONE_INTERMISSION_MS) };
  }
  persistRoom(roomId);
}

function stopPhone(roomId, reason) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearPhoneTimers(room);
  dropRoomPhonePages(room);
  room.phone = null;
  broadcast(roomId, { type: 'phone_state', phone: null, stopped: reason || true });
}

// Auto-run the featured room / opted-in private room: start when enough players
// are present and the game is idle; otherwise park a waiting HUD.
function maybePhoneStart(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.phoneEnabled) return;
  const active = room.phone && !['waiting', 'reveal'].includes(room.phone.phase);
  if (active) return; // a game is mid-flight
  // Reveal pages are freed once we leave the reveal (a new game or a waiting park).
  if (room.phone && room.phone.phase === 'reveal') dropRoomPhonePages(room);
  if (phoneUniquePresent(room) >= PHONE_MIN_PLAYERS) {
    startPhoneGame(roomId);
  } else {
    phoneWaiting(room);
    broadcastPhone(roomId);
  }
}

// Fan a chat message out to cross-room "notifier" sockets watching this room
// whose display name is @mentioned in the message. Lets a painter get pinged
// about mentions in OTHER rooms they're in without a heavy full connection.
// Does `message` contain "@name" as a whole token (not a prefix of a longer
// name, so "@sam" doesn't fire for a watcher named "sa")? Handles multi-word
// names since the '@name' target includes any spaces.
function nameMentioned(lower, name) {
  const target = '@' + name;
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(target, from);
    if (idx === -1) return false;
    const after = lower[idx + target.length];
    if (after === undefined || !/[a-z0-9_]/.test(after)) return true;
    from = idx + 1;
  }
}

// Cross-room @mention notifications are CAPABILITY-gated: joining a room hands
// the client a per-(room,name) secret (`mentionKey` in the connected payload).
// The notify socket must present that key to subscribe — so the channel can't
// be probed by guessing room codes, and the mention body is never sent (only
// "you were mentioned in <room>"). The key is bound to the display NAME, not a
// person, so it proves "was present under this name" rather than identity; the
// rename throttle + duplicate/authority checks bound name recycling, and since
// the payload carries no content the residual is a metadata-only signal. Keys
// persist with the room (server-side only, never shown to other users) so a
// watch survives restarts; the map is bounded and oldest names age out.
function issueMentionKey(room, name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  if (!(room.mentionKeys instanceof Map)) room.mentionKeys = new Map();
  let key = room.mentionKeys.get(n);
  if (!key) {
    key = randomBytes(9).toString('base64url');
    room.mentionKeys.set(n, key);
    while (room.mentionKeys.size > 300) {
      room.mentionKeys.delete(room.mentionKeys.keys().next().value);
    }
    persistRoom(room.code);
  }
  return key;
}

function mentionKeyValid(room, name, key) {
  const n = String(name || '').trim().toLowerCase();
  if (!n || !key || !(room.mentionKeys instanceof Map)) return false;
  return room.mentionKeys.get(n) === key;
}

function notifyMentions(room, roomId, senderName, message, ts) {
  if (!room.notifiers || room.notifiers.size === 0) return;
  const lower = message.toLowerCase();
  const sender = (senderName || '').toLowerCase();
  const now = Date.now();
  for (const ws of room.notifiers) {
    const entry = ws.watch instanceof Map ? ws.watch.get(roomId) : null;
    const name = (entry?.name || '').trim().toLowerCase();
    if (!name || name === sender) continue; // no self-pings
    // Re-verify the capability at delivery time (keys can rotate/expire).
    if (!mentionKeyValid(room, name, entry.key)) continue;
    if (!nameMentioned(lower, name)) continue;
    // Per-watcher rate limit: at most 6 mention deliveries per rolling 60s.
    const bucket = ws.mentionTimes || (ws.mentionTimes = []);
    while (bucket.length && now - bucket[0] > 60000) bucket.shift();
    if (bucket.length >= 6) continue;
    bucket.push(now);
    if (ws.readyState === 1) {
      // NOTE: message text is deliberately NOT included — the notify channel is
      // cross-room, so leaking chat content (esp. from private rooms) would be
      // a privacy hole. Recipients get "you were mentioned in <room>", never
      // the message body.
      ws.send(JSON.stringify({
        type: 'mention',
        room: roomId,
        roomTitle: room.title || null,
        from: senderName || 'someone',
        ts,
      }));
    }
  }
}

// ---- Theme voting (mad-libs prompts, 3 options, room votes) -----------------
// buildTopicOptions() rolls three distinct "Draw a {adj} {subject}" strings,
// each with a 50% chance of a " — {twist}" tail. Rooms vote for 45s; the
// winner becomes room.customPrompt (persisted, beats the daily rotation).
const TOPIC_ADJ = [
  'sleepy', 'giant', 'tiny', 'neon', 'grumpy', 'dancing', 'robot', 'magical',
  'upside-down', 'super speedy', 'invisible', 'sparkly', 'squishy', 'ancient',
  'glow-in-the-dark', 'banana-flavored', 'mysterious', 'fluffy', 'pixelated', 'gigantic',
];
const TOPIC_SUBJECT = [
  'dragon breakfast', 'cat concert', 'space picnic', 'underwater city', 'dino disco',
  'pizza planet', 'haunted treehouse', 'robot bakery', 'penguin parade', 'candy volcano',
  'wizard school bus', 'monster truck rally', 'jellyfish ballet', 'sock puppet band',
  'moon garden', 'ninja tea party', 'cloud castle', 'bug circus', 'taco spaceship',
  'mermaid arcade', 'yeti sleepover', 'donut factory', 'skateboarding turtle', 'library of secrets',
];
const TOPIC_TWIST = [
  'but everything is made of candy', 'during a thunderstorm', 'in the year 3000',
  'but gravity is off', 'with too many googly eyes', 'at the bottom of the ocean',
  'but everyone is a potato', 'in the middle of the night', 'made entirely of spaghetti',
  'while it rains glitter', 'but it keeps melting', 'seen through a keyhole',
];
const VOTE_DURATION_MS = 45_000;
const VOTE_COOLDOWN_MS = 120_000;

function buildTopicOptions() {
  const options = [];
  let guard = 0;
  while (options.length < 3 && guard < 60) {
    guard += 1;
    const adj = pick(TOPIC_ADJ);
    const article = /^[aeiou]/i.test(adj) ? 'an' : 'a';
    let option = `Draw ${article} ${adj} ${pick(TOPIC_SUBJECT)}`;
    if (Math.random() < 0.5) option += ` — ${pick(TOPIC_TWIST)}`;
    if (!options.includes(option)) options.push(option);
  }
  return options;
}

function voteCounts(vote) {
  const counts = [0, 0, 0];
  for (const choice of Object.values(vote.votes)) {
    if (choice >= 0 && choice <= 2) counts[choice] += 1;
  }
  return counts;
}

// Close a room's vote: winner (tie -> lowest index) becomes the room prompt.
// Guarded per room — the timeout may outlive the room or a superseded vote.
function finishVote(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.vote) return;
  const counts = voteCounts(room.vote);
  let winner = 0;
  for (let i = 1; i < 3; i += 1) {
    if (counts[i] > counts[winner]) winner = i;
  }
  const prompt = room.vote.options[winner];
  room.customPrompt = prompt;
  room.vote = null;
  room.voteTimer = null;
  broadcast(roomId, { type: 'vote_result', prompt, counts });
  persistRoom(roomId);
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = (url.searchParams.get('room') || 'MAIN').toUpperCase().slice(0, 16);

  // Notify mode: a lightweight cross-room mention watcher. It joins NO room for
  // drawing/presence — it just subscribes to a set of rooms' chat and receives
  // 'mention' events when the given name is @mentioned there. The client sends
  // {type:'watch', rooms:[{code, name, key}]} to (re)subscribe, where `key` is
  // the mentionKey the room's join handshake issued for that name — a watch
  // subscription without a valid capability key is silently dropped, so this
  // channel cannot be used to probe rooms or impersonate names.
  if (url.searchParams.get('notify') === '1') {
    ws.isNotifier = true;
    ws.watch = new Map(); // code -> { name, key }
    const unwatchAll = () => {
      for (const code of ws.watch.keys()) {
        const r = rooms.get(code);
        if (r && r.notifiers) r.notifiers.delete(ws);
      }
      ws.watch.clear();
    };
    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      if (!data || data.type !== 'watch') return; // 'ping' etc. just keep it alive
      unwatchAll();
      const list = Array.isArray(data.rooms) ? data.rooms.slice(0, 12) : [];
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue; // legacy bare-code watches are gone
        const code = String(entry.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
        const name = String(entry.name || '').trim().slice(0, 40);
        const key = String(entry.key || '').slice(0, 32);
        // Attach only to rooms that actually exist (don't resurrect idle-closed
        // rooms just to watch them); the client re-asserts the watch periodically
        // so a room that (re)opens later still gets picked up.
        const r = code ? rooms.get(code) : null;
        if (!r || !name || !key) continue;
        if (!mentionKeyValid(r, name, key)) continue; // no capability, no watch
        if (!r.notifiers) r.notifiers = new Set();
        r.notifiers.add(ws);
        ws.watch.set(code, { name, key });
      }
    });
    ws.on('close', unwatchAll);
    ws.on('error', unwatchAll);
    ws.send(JSON.stringify({ type: 'notify_ready' }));
    return;
  }

  // Spectator mode: a homepage viewer watches the live mural read-only. It is a
  // PUBLIC-room privilege: private rooms are never watchable (a friends-room
  // code is an invite to draw, not a window for silent strangers), a spectate
  // probe never lazily creates a room, and viewers are capped per room.
  if (url.searchParams.get('spectate') === '1') {
    const live = rooms.get(roomId);
    if (!live || live.audience !== 'kid_safe' || !live.listed) {
      ws.send(JSON.stringify({ type: 'room_blocked', reason: 'not_watchable' }));
      ws.close(1008, 'not watchable');
      return;
    }
    if (live.spectators.size >= MAX_SPECTATORS) {
      ws.send(JSON.stringify({ type: 'room_full', max: MAX_SPECTATORS }));
      ws.close(1008, 'spectators full');
      return;
    }
    if (roomId === 'DAILY') ensureDailyFresh();
    const specFeatured = FEATURED_CODES.has(roomId) ? FEATURED_ROOMS[FEATURED_INDEX.get(roomId)] : null;
    const specPrompt = live.customPrompt || (specFeatured ? dailyPromptFor(specFeatured) : null);
    live.spectators.add(ws);
    ws.isSpectator = true;
    ws.roomId = roomId;
    ws.send(JSON.stringify({
      type: 'connected', userId: 'spectator', userName: 'viewer', userColor: '#9aa6b2',
      roomId, spectator: true, locked: !!live.locked, roomTitle: live.title || null, audience: live.audience,
      prompt: specPrompt,
      wetCanvas: !!live.wetCanvas,
      moderated: live.audience === 'kid_safe',
      watched: live.watchers.size > 0,
    }));
    // Spectators (homepage viewers) get a headcount only — never painter names,
    // so a leaked/guessed room code can't be used to harvest who's in a room.
    // (broadcast() enforces the same rule afterwards with an allowlist.)
    ws.send(JSON.stringify({ type: 'userList', count: live.users.size }));
    // Always send history (even empty) so the spectator view resets cleanly when
    // it hops rooms in the homepage carousel. Capped to the newest 1500 visible
    // ops — plenty for a homepage preview, a fraction of a big room's payload.
    // Animation rooms: spectators watch the FIRST frame only (their single
    // canvas would otherwise overdraw the whole flipbook into one smear).
    // (No chat catch-up either: the read-only viewer ignores chat.)
    const spectatorOps = live.animationEnabled
      ? visibleHistory(live).filter((op) => opFrameId(live, op) === live.frames[0].id)
      : visibleHistory(live);
    ws.send(JSON.stringify({ type: 'history', ops: spectatorOps.slice(-1500) }));
    // Don't point a spectator at a trace-photo id whose in-memory image is gone
    // (e.g. after a restart) — same guard as the member join path.
    if (live.sheetId && (!live.sheetId.startsWith('trace_') || tracePhotos.has(live.sheetId))) {
      ws.send(JSON.stringify({ type: 'sheet', sheetId: live.sheetId }));
    }
    ws.on('message', () => { /* spectators are read-only — ignore anything they send */ });
    const dropSpectator = () => live.spectators.delete(ws);
    ws.on('close', dropSpectator);
    ws.on('error', dropSpectator);
    return;
  }

  const room = getRoom(roomId);

  // DAILY: flip the day on first contact, not the next 60s tick — otherwise a
  // just-past-midnight joiner would see yesterday's mural under today's prompt
  // and then lose their first strokes to the delayed wipe.
  if (roomId === 'DAILY') ensureDailyFresh();
  if (roomId === 'QUEST') {
    const fresh = questSetFor(roomId);
    if (room.quests?.setId !== fresh.setId) {
      room.quests = normalizeQuestState(null, roomId);
      persistRoom(roomId);
      broadcast(roomId, { type: 'quest_state', quest: questPayload(room), reset: true });
    }
  }

  // The prompt shown in the handshake: a theme-vote winner (customPrompt)
  // beats the daily rotation; featured rooms otherwise carry the same daily
  // prompt the lobby shows; ad-hoc rooms have none until they vote one in.
  const featured = FEATURED_CODES.has(roomId) ? FEATURED_ROOMS[FEATURED_INDEX.get(roomId)] : null;
  const roomPrompt = room.customPrompt || (featured ? dailyPromptFor(featured) : null);

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

  // Optional identity. A signed-in user proves who they are with their access
  // token; we validate it with the public anon key (no secrets) and learn their
  // profile. Anonymous users stay anonymous — sign-in only unlocks ownership/
  // host powers, never the ability to draw.
  //
  // Transport (task #40): the web client's FIRST frame is {type:'auth', token}
  // (token:null for guests) so the JWT never rides the URL query string, where
  // proxy/CDN access logs and browser history would capture it. The query param
  // stays as a fallback for the mobile app and stale cached bundles. A non-auth
  // first frame (legacy client) is replayed into the normal handler after join.
  let token = url.searchParams.get('token');
  let replayFirstFrame = null;
  if (!token) {
    const first = await new Promise((resolve) => {
      const finish = (value) => {
        clearTimeout(timer);
        ws.off('message', onFrame);
        ws.off('close', onGone);
        ws.off('error', onGone);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 1500);
      const onFrame = (raw) => finish(raw);
      const onGone = () => finish(null);
      ws.on('message', onFrame);
      ws.on('close', onGone);
      ws.on('error', onGone);
    });
    if (first != null) {
      let hello = null;
      try { hello = JSON.parse(first); } catch { hello = null; }
      if (hello && hello.type === 'auth') {
        token = typeof hello.token === 'string' && hello.token ? hello.token : null;
      } else {
        replayFirstFrame = first; // legacy client_info etc. — process after join
      }
    }
  }
  const identity = token ? await verifyAccessToken(token) : null;
  if (ws.readyState !== 1) return; // user disconnected during validation

  // Re-check capacity AFTER the first-frame auth wait: the pre-wait check can
  // pass for many concurrent joiners who then all self-add, so the authoritative
  // gate is here, immediately before room.users grows.
  if (room.users.size >= MAX_ROOM_USERS) {
    ws.send(JSON.stringify({ type: 'room_full', max: MAX_ROOM_USERS }));
    ws.close(1008, 'room full');
    return;
  }

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
  const name = (identity && identity.displayName) || guestNameFor(room);
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
  analyticsStartSession(roomId, user, req);
  ws.roomId = roomId;
  ws.userId = id;

  // First signed-in grown-up to enter an unowned PRIVATE room claims & hosts it.
  // Guard on still-unowned so two simultaneous joiners can't both claim.
  // PUBLIC rooms are never auto-claimed here: the always-open featured anchors
  // (MAIN, DOODLE, …) are communal free-for-all, and a user-created public room
  // already got its owner at creation time (POST /api/rooms). Without this guard
  // the first signed-in visitor silently "owned" MAIN, so the host-gated Clear
  // dropped everyone else's wipe and the shared mural stacked up un-clearable.
  if (
    user.profileId &&
    !room.ownerProfileId &&
    room.audience !== 'kid_safe' &&
    !FEATURED_CODES.has(roomId)
  ) {
    room.ownerProfileId = user.profileId;
    persistRoom(roomId);
  }
  // Private rooms don't require a signed-in owner, but SOMEONE must be able to
  // moderate — the first person in an ownerless, non-public room becomes its
  // (session-scoped) guest host; reassigned to a present user if the host left.
  if (!room.ownerProfileId && room.audience !== 'kid_safe' && (!room.hostUserId || !room.users.has(room.hostUserId))) {
    room.hostUserId = id;
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
    prompt: roomPrompt,
    wetCanvas: !!room.wetCanvas,
    moderated: room.audience === 'kid_safe',
    watched: room.watchers.size > 0,
    // Capability key for cross-room @mention notifications: proves to the
    // notify channel that this client really held this name in this room, so
    // nobody can subscribe to a room's mentions by guessing names/codes.
    mentionKey: issueMentionKey(room, name),
    // Shared animation: whether this room has the film strip, and its frames.
    animation: !!room.animationEnabled,
    // Finger-paint room: smudge-friendly, always wet, chat-free (pre-readers).
    fingerPaint: !!room.fingerPaint,
    // If this room is a segment of a film, the whole storyboard rides along.
    production: room.productionId && getProduction(room.productionId)
      ? productionSummary(getProduction(room.productionId))
      : null,
    // Any vote already running rides the handshake so late joiners can vote.
    vote: room.vote ? { options: room.vote.options, endsAt: room.vote.endsAt, counts: voteCounts(room.vote) } : null,
    // Draw & Guess: whether this room plays the game (HUD, start button, etc.).
    game: !!room.gameEnabled,
    // Draw Phone: whether this room plays the telephone game.
    phone: !!room.phoneEnabled,
    symmetry: room.symmetry,
    orchestra: !!room.orchestraEnabled,
    quests: questPayload(room),
    storybook: storybookPayload(room),
    remixSource: room.remixSource || null,
  }));
  ws.send(JSON.stringify({ type: 'userList', users: userListOf(room) }));
  // ALWAYS send a history frame on join — even an empty one. The client treats it
  // as the authoritative shared state and clears its canvas before applying it, so
  // joining an empty room reliably shows a blank canvas instead of whatever the
  // client had locally. `frames` makes the flipbook part of that same catch-up:
  // leave, come back, and you see everything your friends did (Google-Docs model).
  // Animation rooms deliver ONE scene at a time (the first, on join) — clients
  // page between scenes with scene_fetch, keeping memory at a scene's worth.
  if (room.animationEnabled) {
    ws.send(JSON.stringify(sceneHistoryMsg(room, room.scenes[0].id)));
    // Catch the joiner up on WHERE everyone already is (presence is otherwise
    // only broadcast at send-time, so a late joiner would see no pips).
    if (room.presence.size) {
      const entries = [];
      room.presence.forEach((p, uid) => {
        const u = room.users.get(uid);
        if (u && uid !== id) entries.push({ userId: uid, name: u.name, color: u.color, sceneId: p.sceneId, frameId: p.frameId });
      });
      if (entries.length) ws.send(JSON.stringify({ type: 'presence_snapshot', entries }));
    }
  } else {
    ws.send(JSON.stringify({ type: 'history', ops: visibleHistory(room), frames: room.frames }));
  }
  // A persisted trace-photo id whose in-memory image is gone (server restart)
  // resolves to nothing — drop it rather than pointing joiners at a 404.
  if (room.sheetId && room.sheetId.startsWith('trace_') && !tracePhotos.has(room.sheetId)) {
    room.sheetId = null;
  }
  if (room.sheetId) {
    ws.send(JSON.stringify({ type: 'sheet', sheetId: room.sheetId }));
  }
  if (room.chat.length) {
    ws.send(JSON.stringify(chatHistoryMsg(room))); // catch the late joiner up on the conversation
  }
  broadcast(roomId, { type: 'userJoined', user: { id, name, color }, userList: userListOf(room) }, id);
  if (room.quests) {
    broadcast(roomId, { type: 'quest_state', quest: questPayload(room) });
  }
  // If this room is a film segment, refresh every member's storyboard so the
  // new painter's crew chip appears on this Part right away.
  if (room.productionId) {
    const joinProduction = getProduction(room.productionId);
    if (joinProduction) broadcastProduction(joinProduction);
  }
  // Draw & Guess: catch the joiner up on any live round, then (if the room was
  // idle and now has enough players) kick a round off.
  if (room.gameEnabled) {
    if (room.game) ws.send(JSON.stringify({ type: 'game_state', game: publicGame(room) }));
    maybeStartGame(roomId);
  }
  // Draw Phone: catch the joiner up on state (+ the reveal if one's showing so
  // they can watch), then start/park a game now that a player may have arrived.
  // A mid-game joiner spectates until the current game reaches its reveal.
  if (room.phoneEnabled) {
    if (room.phone) ws.send(JSON.stringify({ type: 'phone_state', phone: publicPhone(room) }));
    if (room.phone && room.phone.phase === 'reveal') {
      const books = room.phone.books.map((b) => ({
        ownerName: b.ownerName,
        pages: b.pages.map((pg) => ({ type: pg.type, byName: pg.byName, content: pg.content, skipped: !!pg.skipped })),
      }));
      ws.send(JSON.stringify({ type: 'phone_reveal', books }));
    }
    // A seated player who refreshed / dropped mid-round re-enters with no task
    // (the client clears it on 'connected'). Re-deliver their private task so
    // they can still submit — otherwise they're locked out AND their un-submitted
    // seat stalls the whole round to the deadline. If they already submitted,
    // the public phone_state alone renders the "waiting" HUD (no task needed).
    if (phoneActive(room)) {
      const p = room.phone;
      const seat = p.players.indexOf(gameKey(user));
      if (seat >= 0 && !p.submitted.has(gameKey(user))) {
        const book = p.books[phoneBookForSeat(seat, p.round, p.players.length)];
        const top = book.pages[book.pages.length - 1];
        const task = p.phase === 'drawing'
          ? { type: 'phone_task', phase: 'drawing', round: p.round, totalRounds: p.totalRounds, deadline: p.deadline, prompt: String(top.content || '') }
          : { type: 'phone_task', phase: 'guessing', round: p.round, totalRounds: p.totalRounds, deadline: p.deadline, image: String(top.content || '') };
        ws.send(JSON.stringify(task));
      }
    }
    // Only kick off from idle/waiting — never cut a live game or a reveal short.
    if (!room.phone || room.phone.phase === 'waiting') maybePhoneStart(roomId);
  }

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
      case 'client_info':
        analyticsUpdateClientInfo(user, data);
        break;
      case 'op': {
        if (!data.op) break;
        // When a host locks the room, only hosts may keep drawing. This is the
        // real boundary — clients also disable the canvas, but this enforces it.
        if (room.locked && !isHost(room, user)) break;
        // Draw Phone: while a game is running the shared canvas is OFF — every
        // player draws their own PRIVATE page. Drop (never relay) draw ops so
        // pages can't collide or leak before their guess round. This is the
        // authoritative boundary; the client also suppresses sending.
        if (room.phone && (room.phone.phase === 'starting' || room.phone.phase === 'drawing' || room.phone.phase === 'guessing')) break;
        // Drawn-text moderation: SEVERE text is blocked in EVERY room — same
        // contract as chat (a private room is no reason to relay slurs painted
        // as text ops). Imagery is handled by the watcher/flag path. O(small),
        // synchronous — adds no latency to the normal draw-op relay below.
        if (data.op.kind === 'text' && typeof data.op.text === 'string') {
          const verdict = scan(data.op.text);
          if (verdict.severity === 'severe') {
            autoModerate(room, user, `drawn text: ${verdict.terms.join(', ')}`);
            break;
          }
        }
        // Smudge is a private-room brush: never let its ops land in a public
        // room — EXCEPT the finger-paint room, where smearing is the toy.
        if (room.audience === 'kid_safe' && !room.fingerPaint && data.op.kind === 'draw' && data.op.settings && data.op.settings.brush === 'smudge') break;
        // Imported stamp tips are arbitrary user media. Keep public kid-safe
        // rooms on reviewed catalog brushes until brush assets have moderation.
        if (room.audience === 'kid_safe' && data.op.kind === 'draw' && data.op.settings?.dab?.shape === 'stamp') break;
        // Draw ops should stay tiny: brush settings plus a short point batch.
        // This protects v3 inline brush params from becoming a history/memory
        // abuse vector while still allowing large image imports via image ops.
        if (data.op.kind === 'draw') {
          if (raw.length > MAX_DRAW_MESSAGE_CHARS) break;
          if (!Array.isArray(data.op.points) || data.op.points.length > MAX_DRAW_POINTS_PER_OP) break;
          if (data.op.settings?.symmetry) {
            data.op = {
              ...data.op,
              settings: { ...data.op.settings, symmetry: normalizeRoomSymmetry(data.op.settings.symmetry) },
            };
          }
        }
        // Bound single-op weight: image ops embed dataURLs; nothing legitimate
        // approaches this cap, and unbounded ops multiply across history/joins.
        if (typeof data.op.dataUrl === 'string' && data.op.dataUrl.length > MAX_OP_DATAURL_CHARS) break;
        // Animation frames: an op may target a specific shared frame. Validate
        // the frame exists (stale clients race frame deletes) and enforce the
        // per-frame cap by REJECTING — FIFO-trimming would rot early frames.
        let frameId = null;
        if (data.op.frameId != null) {
          frameId = String(data.op.frameId).slice(0, 24);
          if (!room.frames.some((f) => f.id === frameId)) break;
          // Rooms without animation only ever accept ops for their first frame.
          if (!room.animationEnabled && frameId !== room.frames[0].id) break;
        }
        if (room.storybook?.enabled) {
          const targetFrame = room.frames.find((item) => item.id === (frameId || room.frames[0].id));
          const targetPage = room.storybook.pages.find((item) => item.sceneId === targetFrame?.sceneId);
          if (targetPage?.locked && !isHost(room, user)) break;
        }
        // Multi-frame rooms (animation on, or a preserved flipbook with the
        // toggle off) live under per-frame caps — the global FIFO trim would
        // silently rot early frames, so it only applies to single-frame rooms.
        const multiFrame = room.animationEnabled || room.frames.length > 1;
        const countKey = frameId || room.frames[0].id;
        const frameCount = room.frameOpCounts.get(countKey) || 0;
        if (multiFrame && (frameCount >= FRAME_OP_CAP || room.history.length >= MAX_ANIM_ROOM_OPS)) {
          if (data.op.kind === 'draw' && data.op.end) {
            // Relay the end marker so peers close their stroke buffers, but
            // don't grow history/counts — the cap is a hard ceiling for EVERY
            // op kind (shape/text/image included), or history is unbounded.
            broadcast(roomId, { type: 'op', op: { ...data.op, userId: id } }, id);
          } else {
            ws.send(JSON.stringify({ type: 'frame_full', frameId: countKey }));
          }
          break;
        }
        // Tag with the author so replay/cursors can attribute it, plus a stable
        // monotonic opId so moderation can hide/restore individual ops later.
        // Animation rooms also stamp the resolved frameId so ops never re-bind
        // to "whichever frame is first" if frame 1 is later moved or deleted.
        const op = { ...data.op, userId: id, opId: (room.opSeq = (room.opSeq || 0) + 1) };
        if (room.animationEnabled && !op.frameId) {
          op.frameId = room.frames[0].id;
        }
        analyticsRecordDraw(roomId, user, op);
        room.history.push(op);
        room.frameOpCounts.set(countKey, frameCount + 1);
        if (!multiFrame && room.history.length > MAX_HISTORY) {
          room.history.splice(0, room.history.length - MAX_HISTORY);
          recountFrameOps(room);
        }
        broadcast(roomId, { type: 'op', op }, id);
        persistRoom(roomId);
        break;
      }
      case 'cursor':
        // Draw Phone: cursors are private too — don't telegraph where a player
        // is drawing their secret page.
        if (phoneActive(room)) break;
        broadcast(roomId, {
          type: 'cursor', userId: id, name: user.name, color: user.color,
          x: data.x, y: data.y, drawing: !!data.drawing,
        }, id);
        break;
      case 'set_sheet': {
        // Setting the shared coloring sheet is a host decision once the room is
        // owned. Legacy unowned rooms stay open so existing behavior is unchanged.
        if (room.ownerProfileId && !isHost(room, user)) break;
        if (phoneActive(room)) break; // the sheet is locked while a phone game runs
        if (room.storybook?.enabled) break;
        const nextSheet = data.sheetId ? String(data.sheetId).slice(0, 200) : null;
        // Trace photos and Draw Phone pages can ONLY be set by their own minting
        // handlers (each binds an id to this room). Rejecting trace_/pp_ ids here
        // stops re-broadcasting another room's — or another player's — private image.
        if (nextSheet && (nextSheet.startsWith('trace_') || nextSheet.startsWith('pp_'))) break;
        dropRoomTracePhoto(room); // replacing/clearing frees the old photo
        room.sheetId = nextSheet;
        broadcast(roomId, { type: 'sheet', sheetId: room.sheetId });
        persistRoom(roomId);
        break;
      }
      // Upload a user PHOTO as the room's traced underlay for everyone. SAFETY
      // GATE: a photo shows on every screen instantly, so it needs an
      // accountable uploader — allowed only in PRIVATE rooms (a known friend
      // group) or when the sender is the HOST of an owned public room; the
      // hostless public drawing rooms can NEVER accept one. The client also
      // runs an NSFW pre-check, but the gate is the real control.
      case 'set_trace_photo': {
        if (room.storybook?.enabled) break;
        if (user.muted) break; // a muted member can't push a photo either
        if (room.locked && !isHost(room, user)) break; // locked room = host-only
        if (room.audience === 'kid_safe') {
          // Public room: must be owned AND the sender must be its host.
          if (!room.ownerProfileId || !isHost(room, user)) break;
        }
        // (Private "friends" rooms: any member may set it.)
        // Rate-limit: each accepted photo is a synchronous decode + a fan-out to
        // every user AND spectator, so cap it hard per uploader.
        if (!rateOk(`trace:${id}`, 6, 60_000)) break;
        const clean = validateTracePhoto(data.image);
        if (!clean) {
          if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'trace_rejected' }));
          break;
        }
        dropRoomTracePhoto(room); // free the photo this one replaces
        const traceId = storeTracePhoto(roomId, clean);
        room.sheetId = traceId;
        broadcast(roomId, { type: 'sheet', sheetId: traceId });
        persistRoom(roomId);
        break;
      }
      case 'rename': {
        // Throttle renames: unbounded renaming lets one socket mint/evict
        // mention-watch keys and spam "X is now Y" system lines. 8 per minute
        // is generous for a real person fiddling with their name.
        if (!rateOk(`rename:${id}`, 8, 60_000)) break;
        if (typeof data.name === 'string' && data.name.trim()) {
          const proposed = data.name.trim().slice(0, 20);
          const lower = proposed.toLowerCase();
          // Names are a social-engineering surface: block slurs, authority-figure
          // impersonation, and copying another person already in the room.
          const severe = scan(proposed).severity === 'severe';
          const impersonates = /\b(teacher|coach|parent|mom|dad|mum|admin|moderator|mod|officer|police|staff|owner|host)\b/i.test(proposed);
          let duplicate = false;
          for (const u of room.users.values()) {
            if (u !== user && (u.name || '').trim().toLowerCase() === lower) { duplicate = true; break; }
          }
          if (severe || impersonates || duplicate) {
            if (user.ws.readyState === 1) {
              user.ws.send(JSON.stringify({
                type: 'rename_rejected',
                reason: severe ? "that name isn't allowed" : impersonates ? "that name could impersonate a grown-up" : "someone here already uses that name",
                name: user.name,
              }));
            }
          } else {
            const old = user.name;
            user.name = proposed;
            if (old && old !== proposed) {
              broadcast(roomId, { type: 'system', text: `${old} is now ${proposed}` });
            }
            // A new name needs its own mention-watch capability for this room.
            if (user.ws.readyState === 1) {
              user.ws.send(JSON.stringify({ type: 'mention_key', room: roomId, name: proposed, key: issueMentionKey(room, proposed) }));
            }
          }
        }
        if (typeof data.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(data.color)) {
          user.color = data.color;
        }
        broadcast(roomId, { type: 'userList', users: userListOf(room) });
        break;
      }
      case 'reaction': {
        // Ephemeral emoji reactions floated over the canvas. Never persisted, never
        // in history — just relayed so friends can cheer each other on.
        const REACTS = ['👍', '🔥', '❤️', '😂', '🎨', '⭐', '👏', '🌈'];
        if (!REACTS.includes(data.emoji)) break;
        if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) break;
        const nowR = Date.now();
        const times = user.reactionTimes || (user.reactionTimes = []);
        while (times.length && nowR - times[0] > 1000) times.shift();
        if (times.length >= 5) break; // ~5/sec per user
        times.push(nowR);
        broadcast(roomId, { type: 'reaction', emoji: data.emoji, x: data.x, y: data.y, userId: id, name: user.name });
        break;
      }
      // ---- Crew presence: who's painting which cel (animation rooms) --------
      // COLD path only — the client fires this on frame-select / scene-switch /
      // join, never per stroke or cursor-move. Purely ephemeral: relayed +
      // remembered in room.presence, never touches history or the draw path.
      case 'frame_presence': {
        if (!room.animationEnabled) break;
        const pSceneId = data.sceneId != null ? String(data.sceneId).slice(0, 24) : null;
        const pFrameId = data.frameId != null ? String(data.frameId).slice(0, 24) : null;
        // Drop stale ids (raced a delete) rather than advertising a ghost cel.
        if (pFrameId && !room.frames.some((f) => f.id === pFrameId)) break;
        if (pSceneId && !room.scenes.some((s) => s.id === pSceneId)) break;
        const nowP = Date.now();
        const pt = user.presenceTimes || (user.presenceTimes = []);
        while (pt.length && nowP - pt[0] > 1000) pt.shift();
        if (pt.length >= 5) break; // ~5/sec per user — cold path, generous
        pt.push(nowP);
        room.presence.set(id, { sceneId: pSceneId, frameId: pFrameId, ts: nowP });
        broadcast(roomId, { type: 'frame_presence', userId: id, name: user.name, color: user.color, sceneId: pSceneId, frameId: pFrameId }, id);
        break;
      }
      // "Come look at my frame!" — a location beacon (room+scene+frame), never
      // free text. Peers get a tap-to-jump toast; honoring it is opt-in.
      case 'beacon': {
        if (!room.animationEnabled) break;
        const bSceneId = data.sceneId != null ? String(data.sceneId).slice(0, 24) : null;
        const bFrameId = data.frameId != null ? String(data.frameId).slice(0, 24) : null;
        if (bFrameId && !room.frames.some((f) => f.id === bFrameId)) break;
        const nowB = Date.now();
        const bt = user.beaconTimes || (user.beaconTimes = []);
        while (bt.length && nowB - bt[0] > 3000) bt.shift();
        if (bt.length >= 1) break; // 1 per 3s — a summon, not a spam toy
        bt.push(nowB);
        // roomCode = the SENDER's room, so peers in other Parts hop via /join
        // while same-room peers land locally.
        const beaconMsg = { type: 'beacon', fromUserId: id, name: user.name, color: user.color, roomCode: roomId, sceneId: bSceneId, frameId: bFrameId };
        const beaconProd = room.productionId && getProduction(room.productionId);
        if (beaconProd) {
          // Summon the WHOLE crew across every Part of the film, not just this
          // room — "come see my frame in Part 3" is the point.
          for (const code of beaconProd.segments) {
            if (rooms.has(code)) broadcast(code, beaconMsg, code === roomId ? id : null);
          }
        } else {
          broadcast(roomId, beaconMsg, id);
        }
        break;
      }
      // Confetti cheer on a specific frame — pure celebration. Curated emoji
      // only (no text), ephemeral, echoed to the cheerer too so they see it pop.
      case 'cheer': {
        if (!room.animationEnabled) break;
        const CHEERS = ['⭐', '❤️', '🎉', '👏', '🌟', '🥳'];
        if (!CHEERS.includes(data.emoji)) break;
        const cheerFrameId = data.frameId != null ? String(data.frameId).slice(0, 24) : null;
        if (cheerFrameId && !room.frames.some((f) => f.id === cheerFrameId)) break;
        const nowC = Date.now();
        const ct = user.cheerTimes || (user.cheerTimes = []);
        while (ct.length && nowC - ct[0] > 1000) ct.shift();
        if (ct.length >= 4) break; // ~4/sec per user
        ct.push(nowC);
        broadcast(roomId, { type: 'cheer', frameId: cheerFrameId, emoji: data.emoji, userId: id, name: user.name });
        break;
      }
      case 'clear': {
        // In an owned room only a host may wipe the shared mural; unowned public
        // rooms keep the original free-for-all behavior.
        if (room.ownerProfileId && !isHost(room, user)) break;
        // Draw Phone: each player's page is private and independent — a shared
        // clear would wipe everyone's in-progress drawing. Only the engine blanks.
        if (phoneActive(room)) break;
        if (room.storybook?.enabled && !isHost(room, user)) break;
        const clearFrameId = data.frameId != null ? String(data.frameId).slice(0, 24) : null;
        if (room.animationEnabled && clearFrameId && room.frames.some((f) => f.id === clearFrameId)) {
          // Animation rooms: Clear wipes ONE frame for everyone (never the whole
          // movie, and never the room's coloring sheet).
          const belongs = (op) => opFrameId(room, op) === clearFrameId;
          room.lastCleared = room.history.filter(belongs);
          room.lastClearedFrameId = clearFrameId;
          room.lastClearedSheet = null;
          room.history = room.history.filter((op) => !belongs(op));
          room.frameOpCounts.set(clearFrameId, 0);
          analyticsRecordClear(roomId, user, 'user');
          broadcast(roomId, { type: 'clear', userId: id, name: user.name, frameId: clearFrameId }, id);
          persistRoom(roomId);
          break;
        }
        // Keep a backup so the room can undo a clear (everyone gets mad otherwise).
        room.lastCleared = room.history;
        room.lastClearedFrameId = null;
        room.lastClearedSheet = room.sheetId; // undo brings the sheet back too
        room.history = [];
        recountFrameOps(room);
        analyticsRecordClear(roomId, user, 'user');
        broadcast(roomId, { type: 'clear', userId: id, name: user.name }, id);
        // A full clear blanks the canvas completely — drop the coloring sheet too.
        // Sheet state is separate from stroke history, so without this the sheet
        // survives every wipe and reloads for everyone on each visit (the stuck
        // "Pikachu on MAIN" bug). Echoed to the clearer too (no sender exclusion).
        if (room.sheetId) {
          room.sheetId = null;
          broadcast(roomId, { type: 'sheet', sheetId: null });
        }
        persistRoom(roomId);
        break;
      }
      case 'undo_clear':
        if (room.ownerProfileId && !isHost(room, user)) break;
        if (phoneActive(room)) break; // no resurrecting the pre-game canvas mid-game
        // Restore the most recently cleared mural/frame AND any sheet it removed.
        if ((room.lastCleared && room.lastCleared.length) || room.lastClearedSheet) {
          if (room.lastCleared && room.lastCleared.length) {
            if (room.lastClearedFrameId) {
              // Per-frame restore: merge the backup in and re-sort by opId so
              // replay order stays globally monotonic.
              if (room.frames.some((f) => f.id === room.lastClearedFrameId)) {
                room.history = room.history.concat(room.lastCleared).sort((a, b) => (a.opId || 0) - (b.opId || 0));
              }
              room.lastClearedFrameId = null;
            } else {
              // Full-mural restore: drop ops for frames deleted after the clear
              // (they'd be zombie ops nothing can render or moderate away).
              const live = new Set(room.frames.map((f) => f.id));
              room.history = room.lastCleared.filter((op) => live.has(opFrameId(room, op)));
            }
            recountFrameOps(room);
            if (room.animationEnabled) {
              // Scene-paged clients can't take a whole-movie history frame —
              // each refetches its own active scene instead.
              broadcast(roomId, { type: 'resync', restored: true });
            } else {
              broadcast(roomId, { type: 'history', ops: visibleHistory(room), frames: room.frames, restored: true });
            }
          }
          room.lastCleared = null;
          if (room.lastClearedSheet) {
            room.sheetId = room.lastClearedSheet;
            room.lastClearedSheet = null;
            broadcast(roomId, { type: 'sheet', sheetId: room.sheetId });
          }
          persistRoom(roomId);
        }
        break;
      case 'chat': {
        if (room.fingerPaint) break; // no chat in the toddler room (pre-readers)
        if (user.muted) break; // a host muted this user
        if (typeof data.message !== 'string' || !data.message.trim()) break;
        let message = String(data.message).slice(0, 300);
        // Chat moderation. SEVERE content is blocked in EVERY room (public AND
        // private) — a private room being "for friends" is no reason to relay
        // slurs/explicit terms. The softer MILD masking stays public-only so
        // private rooms aren't over-filtered on ordinary words.
        {
          const verdict = scan(message);
          if (verdict.severity === 'severe') {
            autoModerate(room, user, `chat: ${verdict.terms.join(', ')}`);
            if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'chat_blocked' }));
            break;
          }
          if (verdict.hit && room.audience === 'kid_safe') message = maskMessage(message);
        }
        // Draw & Guess: a message that is (or contains) the secret word is a
        // guess — score it and SUPPRESS the raw text so the word never leaks to
        // the room. Non-matching chat falls through and shows normally.
        if (room.gameEnabled && room.game && room.game.phase === 'playing') {
          const outcome = handleGuess(room, roomId, user, message);
          if (outcome === 'correct') break; // scored + announced; don't echo the word
          if (outcome === 'spoiler') {
            if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'game_spoiler' }));
            break; // drawer / already-correct typed the word — swallow it
          }
        }
        // Flood guard — AFTER the guess intercept, so a correct guess is never
        // throttled. Wrong guesses still echo as chat, so the cap loosens
        // during a live round (machine-gun guessing IS the game). Feedback on drop.
        {
          const now = Date.now();
          const cap = room.gameEnabled && room.game && room.game.phase === 'playing' ? 20 : 8;
          user.chatTimes = (user.chatTimes || []).filter((t) => now - t < 10_000);
          if (user.chatTimes.length >= cap) {
            if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'chat_blocked', reason: 'slow_down' }));
            break;
          }
          user.chatTimes.push(now);
        }
        const chatTs = Date.now();
        const entry = { id: ++room.chatSeq, user: { id, name: user.name, color: user.color }, message, ts: chatTs };
        // Reply-threading: the client names a target id; the SERVER derives the
        // quoted context from its own buffer (never client text), so a reply
        // can't fabricate what someone said. Unknown/expired id → plain message.
        const replyTarget = Number.isFinite(Number(data.replyToId))
          ? room.chat.find((c) => c.id === Number(data.replyToId))
          : null;
        if (replyTarget) {
          // Draw & Guess leak guard: handleGuess only inspects data.message, so
          // a reply QUOTING an old line that contains the live secret word would
          // smuggle it to the room. Drop the quote (keep the message) on a hit.
          const g = room.gameEnabled && room.game && room.game.phase === 'playing' ? room.game : null;
          const quoteLeaks = g && g.word && squishGuess(replyTarget.message).includes(squishGuess(g.word));
          if (!quoteLeaks) {
            entry.replyTo = { id: replyTarget.id, name: replyTarget.user.name, snippet: String(replyTarget.message).slice(0, 70) };
          }
        }
        // 1) capped buffer (late-joiner context + report context), persisted with the room
        room.chat.push(entry);
        if (room.chat.length > CHAT_BUFFER_MAX) room.chat.splice(0, room.chat.length - CHAT_BUFFER_MAX);
        // 2) durable append-only audit log (keeps the profileId for deletion scrubs)
        appendChatAudit(roomId, { ts: chatTs, room: roomId, userId: id, profileId: user.profileId || null, name: user.name, message });
        broadcast(roomId, { type: 'chat', msgId: entry.id, user: entry.user, message, ts: chatTs, ...(entry.replyTo ? { replyTo: entry.replyTo } : {}) });
        analyticsRecordChat(roomId, user);
        // Ping cross-room watchers who are @mentioned here (see notifyMentions).
        notifyMentions(room, roomId, user.name, message, chatTs);
        persistRoom(roomId);
        break;
      }

      // iMessage-style tapback on one chat bubble: toggles the sender's emoji
      // on/off. Allowlisted emoji only; membership stored by stable gameKey
      // (so a reconnect can still un-react) but only COUNTS ever leave the
      // server — see the chat_history projection.
      case 'chat_react': {
        if (room.fingerPaint) break;
        if (user.muted) break;
        const emoji = String(data.emoji || '');
        if (!CHAT_TAPBACKS.includes(emoji)) break;
        {
          const now = Date.now();
          user.tapbackTimes = (user.tapbackTimes || []).filter((t) => now - t < 2000);
          if (user.tapbackTimes.length >= 8) break;
          user.tapbackTimes.push(now);
        }
        const msgId = Number(data.msgId);
        const line = Number.isFinite(msgId) ? room.chat.find((c) => c.id === msgId) : null;
        if (!line) break; // expired out of the buffer or never existed
        if (!line.reactions) line.reactions = {};
        const key = gameKey(user);
        const list = line.reactions[emoji] || [];
        const at = list.indexOf(key);
        if (at >= 0) list.splice(at, 1);
        else {
          if (list.length >= 40) break; // a bubble can only get so loved
          list.push(key);
        }
        if (list.length) line.reactions[emoji] = list;
        else delete line.reactions[emoji];
        // The room learns COUNTS only — never who reacted. The reactor alone
        // gets a private ack so their own chip can highlight.
        broadcast(roomId, { type: 'chat_react', msgId, emoji, count: list.length });
        if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'chat_react_self', msgId, emoji, on: at < 0 }));
        persistRoom(roomId);
        break;
      }

      // Big animated "hype" reaction over the canvas (the Twitch-alert moment).
      // Curated kinds only — the client renders each as a pure-CSS celebration,
      // so no external content ever reaches a kid-safe room. Ephemeral.
      case 'hype': {
        if (room.fingerPaint) break;
        if (user.muted) break;
        const kind = String(data.kind || '');
        if (!HYPE_KINDS.includes(kind)) break;
        {
          const now = Date.now();
          user.hypeTimes = (user.hypeTimes || []).filter((t) => now - t < 5000);
          if (user.hypeTimes.length >= 3) break; // big effects stay special
          user.hypeTimes.push(now);
        }
        broadcast(roomId, { type: 'hype', kind, userId: id, name: user.name });
        break;
      }

      // ---- Wet canvas (paint mixing) toggle ---------------------------------
      case 'set_wet': {
        // Hosts flip it in public rooms; in a private room any member may.
        if (room.audience === 'kid_safe' && !isHost(room, user)) break;
        room.wetCanvas = !!data.wet;
        broadcast(roomId, { type: 'wet_state', wet: room.wetCanvas });
        persistRoom(roomId);
        break;
      }

      // ---- Creative room capabilities --------------------------------------
      case 'set_symmetry': {
        // The featured room is deliberately predictable: every visitor sees
        // the same four-way mandala. Private-room hosts can choose other modes.
        if (room.audience === 'kid_safe' || !isHost(room, user)) break;
        if (!rateOk(`symmetry:${id}`, 12, 60_000)) break;
        room.symmetry = normalizeRoomSymmetry(data.mode);
        broadcast(roomId, { type: 'symmetry_state', symmetry: room.symmetry });
        persistRoom(roomId);
        break;
      }
      case 'quest_nominate': {
        if (!room.quests || user.muted) break;
        const missionId = String(data.missionId || '').slice(0, 48);
        if (!room.quests.missionIds.includes(missionId) || room.quests.completedIds.has(missionId)) break;
        let voters = room.quests.nominations.get(missionId);
        if (!voters) {
          voters = new Set();
          room.quests.nominations.set(missionId, voters);
        }
        voters.add(id);
        const needed = Math.max(1, Math.floor(room.users.size / 2) + 1);
        let justCompleted = false;
        if (voters.size >= needed) {
          room.quests.completedIds.add(missionId);
          justCompleted = true;
          persistRoom(roomId);
        }
        broadcast(roomId, { type: 'quest_state', quest: questPayload(room), justCompleted: justCompleted ? missionId : null });
        break;
      }
      case 'quest_reset': {
        if (!room.quests || !isHost(room, user)) break;
        room.quests = normalizeQuestState(null, roomId);
        broadcast(roomId, { type: 'quest_state', quest: questPayload(room), reset: true });
        persistRoom(roomId);
        break;
      }
      case 'storybook_caption': {
        if (!room.storybook?.enabled || user.muted) break;
        const sceneId = String(data.sceneId || '').slice(0, 24);
        const page = room.storybook.pages.find((item) => item.sceneId === sceneId);
        if (!page || (page.locked && !isHost(room, user))) break;
        const caption = typeof data.caption === 'string' ? data.caption.trim().slice(0, 160) : '';
        if (caption && scan(caption).hit) {
          ws.send(JSON.stringify({ type: 'storybook_rejected', reason: 'text' }));
          break;
        }
        page.caption = caption;
        broadcast(roomId, { type: 'storybook_state', storybook: storybookPayload(room) });
        persistRoom(roomId);
        break;
      }
      case 'storybook_lock': {
        if (!room.storybook?.enabled || !isHost(room, user)) break;
        const sceneId = String(data.sceneId || '').slice(0, 24);
        const page = room.storybook.pages.find((item) => item.sceneId === sceneId);
        if (!page) break;
        page.locked = !!data.locked;
        broadcast(roomId, { type: 'storybook_state', storybook: storybookPayload(room) });
        persistRoom(roomId);
        break;
      }
      case 'storybook_move': {
        if (!room.storybook?.enabled || !isHost(room, user)) break;
        const sceneId = String(data.sceneId || '').slice(0, 24);
        const from = room.storybook.pages.findIndex((item) => item.sceneId === sceneId);
        const to = Math.max(0, Math.min(room.storybook.pages.length - 1, Number(data.toIndex) || 0));
        if (from < 0 || from === to) break;
        const [page] = room.storybook.pages.splice(from, 1);
        room.storybook.pages.splice(to, 0, page);
        const order = new Map(room.storybook.pages.map((item, index) => [item.sceneId, index]));
        room.scenes.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
        room.frames.sort((a, b) => (order.get(a.sceneId) ?? 999) - (order.get(b.sceneId) ?? 999));
        broadcast(roomId, { type: 'storybook_state', storybook: storybookPayload(room), scenes: scenesMeta(room) });
        persistRoom(roomId);
        break;
      }

      // ---- Shared animation frames ------------------------------------------
      // Frame structure is shared state exactly like strokes: mutations are
      // validated here, applied to the room, and broadcast to EVERYONE
      // (including the sender) so all clients apply them in server order.
      case 'set_animation': {
        // The film strip is a PRIVATE-room setting (host flips it). Public
        // rooms can never opt in — FLIPBOOK is the one public animation room.
        if (room.audience === 'kid_safe') break;
        if (!isHost(room, user)) break;
        if (room.storybook?.enabled) break;
        room.animationEnabled = !!data.enabled;
        // Animation and Draw & Guess are mutually exclusive: the game blanks
        // the canvas frame-agnostically each round, which would desync a
        // multi-frame flipbook. Enabling one turns the other off.
        if (room.animationEnabled && room.gameEnabled) {
          room.gameEnabled = false;
          stopGame(roomId, 'animation_on');
          broadcast(roomId, { type: 'room_game', enabled: false });
        }
        // Draw Phone likewise blanks the canvas per round — same exclusivity.
        if (room.animationEnabled && room.phoneEnabled) {
          room.phoneEnabled = false;
          stopPhone(roomId, 'animation_on');
          broadcast(roomId, { type: 'room_phone', enabled: false });
        }
        broadcast(roomId, { type: 'room_animation', enabled: room.animationEnabled });
        persistRoom(roomId);
        break;
      }
      // ---- Draw & Guess -----------------------------------------------------
      // Private-room host toggles game mode (the featured GUESS room is always
      // on and can't be toggled off). Turning it on auto-starts if enough
      // players are present; off stops any live round.
      case 'set_game': {
        if (GAME_ROOM_CODES.has(roomId)) break; // featured game room is fixed on
        if (room.audience === 'kid_safe') break; // public drawing rooms never opt in
        if (!isHost(room, user)) break;
        room.gameEnabled = !!data.enabled;
        // Mutually exclusive with animation (see set_animation): the per-round
        // canvas wipe would desync a flipbook.
        if (room.gameEnabled && room.animationEnabled) {
          room.animationEnabled = false;
          broadcast(roomId, { type: 'room_animation', enabled: false });
        }
        // Only one game mode at a time: turning Draw & Guess on stops Draw Phone.
        if (room.gameEnabled && room.phoneEnabled) {
          room.phoneEnabled = false;
          stopPhone(roomId, 'game_on');
          broadcast(roomId, { type: 'room_phone', enabled: false });
        }
        broadcast(roomId, { type: 'room_game', enabled: room.gameEnabled });
        if (room.gameEnabled) maybeStartGame(roomId);
        else stopGame(roomId, 'host_off');
        persistRoom(roomId); // the opt-in must survive a restart (like animation)
        break;
      }
      // End the current round now → reveal + rotate. Allowed by the drawer
      // (skip my turn) or a host. No-op when nothing's playing.
      case 'game_skip': {
        if (!room.gameEnabled || !room.game || room.game.phase !== 'playing') break;
        if (user.id !== room.game.drawerId && !isHost(room, user)) break;
        endGameRound(roomId, 'skipped');
        break;
      }
      // ---- Draw Phone -------------------------------------------------------
      // Private-room host toggles the telephone game (featured DRAWPHONE is
      // fixed on). Turning it on parks a waiting HUD / auto-starts if enough
      // players are present; off stops any live game and frees its pages.
      case 'set_phone': {
        if (PHONE_ROOM_CODES.has(roomId)) break; // featured phone room is fixed on
        if (room.audience === 'kid_safe') break; // public drawing rooms never opt in
        if (!isHost(room, user)) break;
        room.phoneEnabled = !!data.enabled;
        if (room.phoneEnabled && room.animationEnabled) {
          room.animationEnabled = false;
          broadcast(roomId, { type: 'room_animation', enabled: false });
        }
        if (room.phoneEnabled && room.gameEnabled) {
          room.gameEnabled = false;
          stopGame(roomId, 'phone_on');
          broadcast(roomId, { type: 'room_game', enabled: false });
        }
        broadcast(roomId, { type: 'room_phone', enabled: room.phoneEnabled });
        if (room.phoneEnabled) maybePhoneStart(roomId);
        else stopPhone(roomId, 'host_off');
        persistRoom(roomId);
        break;
      }
      // A host kicks off / restarts a Draw Phone game (private rooms). The
      // hostless featured PHONE room auto-runs via maybePhoneStart + the
      // intermission timer, so it needs no client start — and isHost is false
      // there, which is exactly what blocks a stranger from driving it.
      case 'phone_start': {
        if (!room.phoneEnabled) break;
        if (!isHost(room, user) || user.muted) break;
        if (room.phone && !['waiting', 'reveal'].includes(room.phone.phase)) break; // already running
        if (room.phone && room.phone.phase === 'reveal') dropRoomPhonePages(room);
        if (phoneUniquePresent(room) < PHONE_MIN_PLAYERS) { maybePhoneStart(roomId); break; }
        startPhoneGame(roomId);
        break;
      }
      // A player submits their page for the current round: a drawn PNG (drawing
      // round) or a text guess (guessing round). One per player per round.
      case 'phone_submit': {
        if (!room.phoneEnabled || !room.phone) break;
        const p = room.phone;
        if (p.phase !== 'drawing' && p.phase !== 'guessing') break;
        if (user.muted) break;
        const key = gameKey(user);
        const seat = p.players.indexOf(key);
        if (seat < 0) break; // not a player in this game (spectator/late joiner)
        if (Number(data.round) !== p.round) break; // stale client (previous round)
        if (p.submitted.has(key)) break; // already submitted this round
        const n = p.players.length;
        const book = p.books[phoneBookForSeat(seat, p.round, n)];
        if (book.pages.length !== p.round + 1) break; // integrity: exactly one page behind
        if (p.phase === 'drawing') {
          if (!rateOk(`phone:${user.id}`, 16, 60_000)) break;
          const clean = validatePhonePage(data.image);
          if (!clean) { if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'phone_rejected', reason: 'image' })); break; }
          const pid = storePhonePage(roomId, clean);
          book.pages.push({ type: 'draw', by: key, byName: p.names[key] || user.name, content: pid });
        } else {
          // Strip control chars (intentional) → collapse to a space, then cap.
          // eslint-disable-next-line no-control-regex
          let text = String(data.text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, PHONE_GUESS_MAX).trim();
          const verdict = scan(text);
          if (verdict.severity === 'severe') {
            autoModerate(room, user, `phone guess: ${verdict.terms.join(', ')}`);
            if (user.ws.readyState === 1) user.ws.send(JSON.stringify({ type: 'phone_rejected', reason: 'text' }));
            break;
          }
          if (verdict.hit) text = maskMessage(text);
          if (!text) text = '(no guess)';
          book.pages.push({ type: 'guess', by: key, byName: p.names[key] || user.name, content: text });
        }
        p.submitted.add(key);
        broadcastPhone(roomId);
        checkPhoneRoundComplete(roomId);
        break;
      }
      // A host force-advances the current round (private rooms; hostless
      // featured rooms rely on the deadline timer). Debounced so a double-click
      // can't cascade through several rounds in one burst.
      case 'phone_skip': {
        if (!room.phoneEnabled || !room.phone) break;
        if (!isHost(room, user) || user.muted) break;
        if (room.phone.phase !== 'drawing' && room.phone.phase !== 'guessing') break;
        if (Date.now() - (room.phone.roundStartedAt || 0) < 1000) break; // ignore a rapid second skip
        fillMissingAndAdvance(roomId);
        break;
      }
      // Clients page between scenes: send them ONE scene's frames + ops.
      case 'scene_fetch': {
        if (!room.animationEnabled) break;
        const fetchId = String(data.sceneId || '').slice(0, 24);
        if (!room.scenes.some((s) => s.id === fetchId)) break;
        ws.send(JSON.stringify(sceneHistoryMsg(room, fetchId)));
        break;
      }
      // Scenes are HOST-only: the host directs the film's structure ("you take
      // scene 2"); members animate within scenes. FLIPBOOK has no host, so the
      // public playground stays single-scene by design.
      case 'scene_add': {
        if (!room.animationEnabled) break;
        if (room.storybook?.enabled) break;
        if (!isHost(room, user)) break;
        if (room.scenes.length >= MAX_SCENES) {
          ws.send(JSON.stringify({ type: 'frame_denied', reason: `Films are capped at ${MAX_SCENES} scenes` }));
          break;
        }
        const scene = { id: `s${(room.opSeq = (room.opSeq || 0) + 1)}`, name: `Scene ${room.scenes.length + 1}` };
        const firstFrame = { id: `f${(room.opSeq = (room.opSeq || 0) + 1)}`, durationMs: 120, sceneId: scene.id };
        room.scenes.push(scene);
        room.frames.push(firstFrame); // scene blocks stay contiguous: appended at the end
        room.frameOpCounts.set(firstFrame.id, 0);
        broadcast(roomId, { type: 'scene_add', scene, scenes: scenesMeta(room), byUserId: id });
        persistRoom(roomId);
        break;
      }
      case 'scene_del': {
        if (!room.animationEnabled) break;
        if (room.storybook?.enabled) break;
        if (!isHost(room, user)) break;
        if (room.scenes.length <= 1) break;
        const delSceneId = String(data.sceneId || '').slice(0, 24);
        const sceneIndex = room.scenes.findIndex((s) => s.id === delSceneId);
        if (sceneIndex < 0) break;
        // Resolve doomed ops BEFORE mutating (untagged ops bind to frames[0]).
        const doomedFrames = new Set(framesOfScene(room, delSceneId).map((f) => f.id));
        const removeOpIds = new Set(
          room.history.filter((op) => doomedFrames.has(opFrameId(room, op))).map((op) => op.opId),
        );
        // If this scene owns the CURRENT first frame, pin any untagged ops in
        // the full-mural undo backup to it now — restoring later must not
        // re-bind them to whichever frame becomes first (same guard as
        // frame_move).
        if (room.lastCleared && !room.lastClearedFrameId && room.frames[0] && doomedFrames.has(room.frames[0].id)) {
          const firstId = room.frames[0].id;
          for (const op of room.lastCleared) {
            if (!op.frameId) op.frameId = firstId;
          }
        }
        room.scenes.splice(sceneIndex, 1);
        room.frames = room.frames.filter((f) => !doomedFrames.has(f.id));
        room.history = room.history.filter((op) => !removeOpIds.has(op.opId));
        doomedFrames.forEach((fid) => room.frameOpCounts.delete(fid));
        // Drop crew presence parked in the deleted scene so a stale cel-pip
        // never re-advertises (presence_snapshot would otherwise re-send it).
        room.presence.forEach((p, uid) => {
          if (p.sceneId === delSceneId || doomedFrames.has(p.frameId)) room.presence.delete(uid);
        });
        if (doomedFrames.has(room.lastClearedFrameId)) {
          room.lastCleared = null;
          room.lastClearedFrameId = null;
        }
        broadcast(roomId, { type: 'scene_del', sceneId: delSceneId, scenes: scenesMeta(room), byUserId: id });
        persistRoom(roomId);
        break;
      }
      case 'frame_add': {
        if (!room.animationEnabled) break;
        if (room.storybook?.enabled) break;
        if (room.locked && !isHost(room, user)) break;
        const afterId = data.afterFrameId != null ? String(data.afterFrameId).slice(0, 24) : null;
        const afterFrame = afterId ? room.frames.find((f) => f.id === afterId) : null;
        const dupId = data.duplicateOf != null ? String(data.duplicateOf).slice(0, 24) : null;
        const dupFrame = dupId ? room.frames.find((f) => f.id === dupId) : null;
        // Which scene does the new frame join? Its anchor's scene, else the
        // requested scene, else the first — and caps apply PER SCENE now.
        const requestedScene = data.sceneId != null ? String(data.sceneId).slice(0, 24) : null;
        const sceneId =
          (afterFrame && afterFrame.sceneId) ||
          (dupFrame && dupFrame.sceneId) ||
          (requestedScene && room.scenes.some((s) => s.id === requestedScene) ? requestedScene : room.scenes[0].id);
        const maxFrames = room.audience === 'kid_safe' ? MAX_ANIM_FRAMES_PUBLIC : MAX_ANIM_FRAMES_PRIVATE;
        if (framesOfScene(room, sceneId).length >= maxFrames) {
          ws.send(JSON.stringify({ type: 'frame_denied', reason: `Scenes are capped at ${maxFrames} frames — add a new scene!` }));
          break;
        }
        const frame = { id: `f${(room.opSeq = (room.opSeq || 0) + 1)}`, durationMs: 120, sceneId };
        // Duplicate: copy the source frame's visible ops under fresh opIds so
        // rejoiners replay the copy identically (the engine is deterministic —
        // same ops, same seeds, same pixels). Clients clone pixels locally.
        if (dupFrame) {
          const copies = visibleHistory(room)
            .filter((op) => opFrameId(room, op) === dupId)
            .map((op) => ({ ...op, frameId: frame.id, opId: (room.opSeq = (room.opSeq || 0) + 1) }));
          // Duplicates count against the room's op budget too — otherwise
          // repeated Duplicate taps grow history past the ceiling ordinary
          // draws are already being rejected at.
          if (room.history.length + copies.length > MAX_ANIM_ROOM_OPS) {
            ws.send(JSON.stringify({ type: 'frame_denied', reason: 'This segment is out of drawing space — start a new one!' }));
            break;
          }
          room.history = room.history.concat(copies);
          room.frameOpCounts.set(frame.id, copies.length);
          frame.durationMs = dupFrame.durationMs;
        } else {
          room.frameOpCounts.set(frame.id, 0);
        }
        // Insert after the anchor, else at the END of the scene's block (keeps
        // scene blocks contiguous in the flat array).
        let insertAt = room.frames.length;
        if (afterFrame) {
          insertAt = room.frames.indexOf(afterFrame) + 1;
        } else {
          for (let i = room.frames.length - 1; i >= 0; i -= 1) {
            if (room.frames[i].sceneId === sceneId) {
              insertAt = i + 1;
              break;
            }
          }
        }
        room.frames.splice(insertAt, 0, frame);
        broadcast(roomId, { type: 'frame_add', frame, afterFrameId: afterId, duplicateOf: dupId, sceneId, scenes: scenesMeta(room), byUserId: id });
        persistRoom(roomId);
        break;
      }
      case 'frame_del': {
        if (room.storybook?.enabled) break;
        if (!room.animationEnabled) break;
        if (room.locked && !isHost(room, user)) break;
        const delId = String(data.frameId || '').slice(0, 24);
        const delIndex = room.frames.findIndex((f) => f.id === delId);
        if (delIndex < 0) break;
        // Every scene keeps at least one frame (delete the SCENE to drop it).
        if (framesOfScene(room, room.frames[delIndex].sceneId).length <= 1) break;
        // Resolve which ops belong to this frame BEFORE the splice — untagged
        // legacy ops resolve to the CURRENT first frame, and mutating the list
        // first would silently migrate them to whichever frame becomes first.
        const removeOpIds = new Set(
          room.history.filter((op) => opFrameId(room, op) === delId).map((op) => op.opId),
        );
        const delSceneId = room.frames[delIndex].sceneId;
        room.frames.splice(delIndex, 1);
        // The frame's ops leave history for good (this is not undo-clearable).
        room.history = room.history.filter((op) => !removeOpIds.has(op.opId));
        room.frameOpCounts.delete(delId);
        // Clear any crew presence parked on the deleted cel (else a stale pip
        // re-advertises to later joiners via presence_snapshot).
        room.presence.forEach((p, uid) => {
          if (p.frameId === delId) room.presence.delete(uid);
        });
        if (room.lastClearedFrameId === delId) {
          room.lastCleared = null;
          room.lastClearedFrameId = null;
        }
        broadcast(roomId, { type: 'frame_del', frameId: delId, sceneId: delSceneId, scenes: scenesMeta(room), byUserId: id });
        persistRoom(roomId);
        break;
      }
      case 'frame_move': {
        if (room.storybook?.enabled) break;
        if (!room.animationEnabled) break;
        if (room.locked && !isHost(room, user)) break;
        const moveId = String(data.frameId || '').slice(0, 24);
        const movedFrame = room.frames.find((f) => f.id === moveId);
        if (!movedFrame) break;
        // toIndex is SCENE-relative (clients only see their scene's frames);
        // map it into the flat array while keeping the scene block contiguous.
        const sceneFrames = framesOfScene(room, movedFrame.sceneId);
        const sceneFrom = sceneFrames.indexOf(movedFrame);
        const sceneTo = Math.max(0, Math.min(sceneFrames.length - 1, Number(data.toIndex) || 0));
        if (sceneFrom === sceneTo) break;
        const fromIndex = room.frames.indexOf(movedFrame);
        const toIndex = room.frames.indexOf(sceneFrames[sceneTo]);
        // Untagged legacy ops resolve to "whichever frame is first" — if this
        // move changes frames[0], pin them to the frame they belong to NOW or
        // they'd silently migrate onto the new first frame.
        if (fromIndex === 0 || toIndex === 0) {
          const firstId = room.frames[0].id;
          for (const op of room.history) {
            if (!op.frameId) op.frameId = firstId;
          }
          if (room.lastCleared && !room.lastClearedFrameId) {
            for (const op of room.lastCleared) {
              if (!op.frameId) op.frameId = firstId;
            }
          }
        }
        const [moved] = room.frames.splice(fromIndex, 1);
        room.frames.splice(toIndex, 0, moved);
        broadcast(roomId, { type: 'frame_move', frameId: moveId, toIndex: sceneTo, sceneId: movedFrame.sceneId, scenes: scenesMeta(room), byUserId: id });
        persistRoom(roomId);
        break;
      }
      case 'frame_duration': {
        if (room.storybook?.enabled) break;
        if (!room.animationEnabled) break;
        if (room.locked && !isHost(room, user)) break;
        const durId = String(data.frameId || '').slice(0, 24);
        const target = room.frames.find((f) => f.id === durId);
        if (!target) break;
        target.durationMs = Math.max(40, Math.min(2000, Number(data.durationMs) || 120));
        broadcast(roomId, { type: 'frame_duration', frameId: durId, durationMs: target.durationMs, sceneId: target.sceneId, scenes: scenesMeta(room), byUserId: id });
        persistRoom(roomId);
        break;
      }

      // ---- Productions: tie segment rooms into one film ---------------------
      // Host-only, private animation rooms only (like scenes). Everyone in any
      // member room gets production_state updates so all storyboards stay live.
      case 'production_create': {
        if (!room.animationEnabled || room.audience === 'kid_safe') break;
        if (!isHost(room, user)) break;
        if (room.productionId && getProduction(room.productionId)) break; // already part of a film
        const production = {
          id: randomBytes(8).toString('hex'),
          title: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 48) : 'Our Movie',
          segments: [roomId],
          createdAt: Date.now(),
        };
        productions.set(production.id, production);
        saveProduction(production);
        room.productionId = production.id;
        if (!room.title) room.title = 'Part 1';
        persistRoom(roomId);
        broadcastProduction(production);
        break;
      }
      case 'production_add_segment': {
        if (!room.productionId) break;
        if (!isHost(room, user)) break;
        const production = getProduction(room.productionId);
        if (!production) break;
        if (production.segments.length >= MAX_PRODUCTION_SEGMENTS) {
          ws.send(JSON.stringify({ type: 'frame_denied', reason: `Films are capped at ${MAX_PRODUCTION_SEGMENTS} parts — that's a feature-length kid flick!` }));
          break;
        }
        if (!rateOk(`prod:${user.profileId || id}`)) break; // reuse the room-creation limiter
        const code = genRoomCode();
        const segmentRoom = getRoom(code);
        segmentRoom.audience = 'friends';
        segmentRoom.listed = false;
        segmentRoom.animationEnabled = true;
        segmentRoom.title = `Part ${production.segments.length + 1}`;
        segmentRoom.productionId = production.id;
        // The creating host directs the new part too (session-scoped until
        // someone joins it; ownership rules unchanged).
        if (user.profileId) segmentRoom.ownerProfileId = user.profileId;
        persistRoom(code);
        production.segments.push(code);
        saveProduction(production);
        broadcastProduction(production);
        break;
      }
      case 'production_rename': {
        if (!room.productionId) break;
        if (!isHost(room, user)) break;
        const production = getProduction(room.productionId);
        if (!production) break;
        const title = typeof data.title === 'string' ? data.title.trim().slice(0, 48) : '';
        if (!title) break;
        if (scan(title).severity === 'severe') break; // film titles are shared surfaces
        production.title = title;
        saveProduction(production);
        broadcastProduction(production);
        break;
      }

      // ---- Theme voting ------------------------------------------------------
      case 'vote_start': {
        // Same power model as set_wet: host-only in public rooms, open in private.
        if (room.audience === 'kid_safe' && !isHost(room, user)) break;
        // The DAILY room's theme IS the daily challenge — no voting it away.
        if (roomId === 'DAILY') {
          ws.send(JSON.stringify({ type: 'vote_denied', reason: "Today's Challenge is the theme — new one tomorrow!" }));
          break;
        }
        const now = Date.now();
        if (room.vote) {
          ws.send(JSON.stringify({ type: 'vote_denied', reason: 'A vote is already running!' }));
          break;
        }
        const wait = VOTE_COOLDOWN_MS - (now - (room.lastVoteAt || 0));
        if (wait > 0) {
          ws.send(JSON.stringify({ type: 'vote_denied', reason: `Next vote unlocks in ${Math.ceil(wait / 1000)}s` }));
          break;
        }
        room.lastVoteAt = now;
        room.vote = { options: buildTopicOptions(), votes: {}, endsAt: now + VOTE_DURATION_MS };
        if (room.voteTimer) clearTimeout(room.voteTimer);
        room.voteTimer = setTimeout(() => finishVote(roomId), VOTE_DURATION_MS);
        broadcast(roomId, { type: 'vote_open', options: room.vote.options, endsAt: room.vote.endsAt });
        break;
      }
      case 'vote': {
        if (!room.vote) break;
        const choice = Number(data.choice);
        if (!Number.isInteger(choice) || choice < 0 || choice > 2) break;
        room.vote.votes[id] = choice; // one vote per user, changeable until close
        broadcast(roomId, { type: 'vote_tally', counts: voteCounts(room.vote) });
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
        if (room.animationEnabled) {
          broadcast(roomId, { type: 'resync' });
        } else {
          broadcast(roomId, { type: 'history', ops: visibleHistory(room), frames: room.frames });
        }
        persistRoom(roomId);
        break;
      }
      case 'mod_restore': {
        if (!isHost(room, user)) break;
        const ids = Array.isArray(data.opIds) ? data.opIds : [];
        if (!ids.length) break;
        ids.forEach((opId) => room.hiddenOpIds.delete(opId));
        if (room.animationEnabled) {
          broadcast(roomId, { type: 'resync', restored: true });
        } else {
          broadcast(roomId, { type: 'history', ops: visibleHistory(room), frames: room.frames, restored: true });
        }
        persistRoom(roomId);
        break;
      }
      case 'mod_remove': {
        if (!isHost(room, user)) break;
        const ids = new Set(Array.isArray(data.opIds) ? data.opIds : []);
        if (!ids.size) break;
        room.history = room.history.filter((op) => !ids.has(op.opId));
        ids.forEach((opId) => room.hiddenOpIds.delete(opId));
        recountFrameOps(room);
        if (room.animationEnabled) {
          broadcast(roomId, { type: 'resync' });
        } else {
          broadcast(roomId, { type: 'history', ops: visibleHistory(room), frames: room.frames });
        }
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
        // A watcher (or any client) flags a region as possibly lewd. Acted on in
        // every room — private rooms elect watchers too, and a flag there alerts
        // the room's host instead of vanishing. Conservative ladder: a lone flag
        // is Tier-1 (alert the hosts, destroy nothing); corroboration is required
        // before the reversible auto-hide; a kick is NEVER automatic.
        const kind = data.kind === 'text' ? 'text' : 'image';
        const score = Number(data.score) || 0;
        const sinceOpId = Math.max(0, Number(data.sinceOpId) || 0);
        const toOpId = Number(data.toOpId) || 0;
        if (toOpId <= sinceOpId) break;
        const now = Date.now();
        // Per-user flag throttle so a single client can't machine-gun flags.
        const fTimes = (user.flagTimes = (user.flagTimes || []).filter((t) => now - t < FLAG_WINDOW_MS));
        if (fTimes.length >= 6) break;
        fTimes.push(now);
        // Corroboration counts DISTINCT PEOPLE, not distinct sockets: key by
        // profileId when signed in, else by client IP. Two tabs / two sockets
        // from one machine can no longer self-corroborate a reversible auto-hide.
        const flaggerKey = user.profileId || `ip:${rawClientIp(req)}`;
        room.flags = room.flags.filter((f) => now - f.ts < FLAG_WINDOW_MS);
        room.flags.push({ clientId: id, flaggerKey, kind, sinceOpId, toOpId, ts: now });

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
        const flaggers = new Set(overlapping.map((f) => f.flaggerKey || `c:${f.clientId}`));
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
            if (room.animationEnabled) {
              broadcast(roomId, { type: 'resync' });
            } else {
              broadcast(roomId, { type: 'history', ops: visibleHistory(room), frames: room.frames });
            }
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

  // A legacy client's first frame (consumed by the auth wait above) wasn't an
  // auth message — replay it through the real handler now that it's attached.
  if (replayFirstFrame != null) ws.emit('message', replayFirstFrame);

  ws.on('close', () => {
    // Accrue this user's time in the room — engagement extends the auto-close TTL.
    room.userSeconds = (room.userSeconds || 0) + Math.max(0, (Date.now() - user.connectedAt) / 1000);
    analyticsEndSession(user);
    room.users.delete(id);
    room.presence.delete(id); // drop their cel-presence so no dot ghosts on a frame
    if (room.quests) {
      for (const voters of room.quests.nominations.values()) voters.delete(id);
    }
    broadcast(roomId, { type: 'cursor_leave', userId: id });
    broadcast(roomId, { type: 'userLeft', userId: id, userList: userListOf(room) });
    if (room.quests) {
      broadcast(roomId, { type: 'quest_state', quest: questPayload(room) });
    }
    // Draw & Guess: if the drawer bailed mid-round, end the round now (it'll
    // rotate to the next player). If the room dropped below the minimum, park
    // the game in "waiting" so it resumes when someone rejoins.
    if (room.gameEnabled && room.game) {
      if (room.game.phase === 'playing' && id === room.game.drawerId) {
        endGameRound(roomId, 'drawer_left');
      } else if (gamePlayers(room).length < GAME_MIN_PLAYERS && room.game.phase !== 'waiting') {
        clearGameTimers(room);
        room.game.phase = 'waiting';
        room.game.drawerId = null;
        broadcastGame(roomId);
      } else if (room.game.phase === 'playing') {
        // A guesser left — if the remaining guessers have all solved it, the
        // round is done (their departure completed the "everyone guessed"
        // condition, which is otherwise only checked on a guess).
        checkAllGuessed(roomId);
        broadcastGame(roomId); // refresh the scoreboard without the departed player
      }
    }
    // Draw Phone: a leaver's book gets a placeholder at round-advance. Their
    // departure may complete the "everyone submitted" check; if too few remain
    // to make a game, jump to the reveal so nobody's stuck waiting.
    if (room.phoneEnabled && room.phone) {
      const phase = room.phone.phase;
      if (phase === 'drawing' || phase === 'guessing') {
        // Count SEATED players still present, not spectators — else a room with
        // a couple of watchers grinds every remaining round out to its deadline.
        if (phonePresentKeys(room).length < 2) startPhoneReveal(roomId);
        else { broadcastPhone(roomId); checkPhoneRoundComplete(roomId); }
      } else if (phase === 'waiting') {
        broadcastPhone(roomId);
      }
    }
    // A film's storyboard shows live crew chips per Part — refresh so this
    // painter's chip vanishes from the board the moment they leave.
    if (room.productionId) {
      const production = getProduction(room.productionId);
      if (production) broadcastProduction(production);
    }
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

// Resolve the owner key for an artwork request, preventing IDOR. A signed-in
// caller's account key is derived from their bearer token (never trusting a
// client-supplied userKey), so nobody can read/overwrite/delete another
// account's gallery by spoofing `userKey=pb_<theirId>`.
//   - valid token            → `pb_<profileId>` (client userKey ignored)
//   - token present, invalid → null (reject with 401)
//   - no token               → the client userKey, but ONLY device keys
//                              (anything starting with `pb_` is rejected →
//                              null, since account keys require auth)
async function resolveArtOwner(req) {
  const token = bearerToken(req);
  if (token) {
    let identity = null;
    try {
      identity = await verifyAccessToken(token);
    } catch {
      identity = null; // network hiccup → treat as invalid token
    }
    if (!identity || !identity.profileId) return null;
    return sanitizeKey(`pb_${identity.profileId}`);
  }
  // No token: only allow anonymous device keys, never account keys.
  const raw = req.body && req.body.userKey != null ? req.body.userKey : req.query.userKey;
  const key = sanitizeKey(raw);
  if (!key || key.startsWith('pb_')) return null;
  return key;
}

app.use(express.json({ limit: '16mb' }));

app.get('/api/artworks', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = await resolveArtOwner(req);
  if (key === null) {
    return res.status(401).json({ error: 'auth_required' });
  }
  if (!key) {
    return res.json({ items: [], max: MAX_SAVES });
  }
  const items = loadUserArt(key).map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt, thumb: a.thumb }));
  res.json({ items, max: MAX_SAVES });
});

app.get('/api/artworks/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const key = await resolveArtOwner(req);
  if (key === null) {
    return res.status(401).json({ error: 'auth_required' });
  }
  const item = loadUserArt(key).find((a) => a.id === req.params.id);
  if (!item) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ id: item.id, name: item.name, image: item.image });
});

app.post('/api/artworks', async (req, res) => {
  const key = await resolveArtOwner(req);
  if (key === null) {
    return res.status(401).json({ error: 'auth_required' });
  }
  const { name, image, thumb } = req.body || {};
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
  analyticsRecordGallerySave(key, req);
  res.json({ ok: true, id: item.id, count: arr.length, max: MAX_SAVES });
});

app.delete('/api/artworks/:id', async (req, res) => {
  const key = await resolveArtOwner(req);
  if (key === null) {
    return res.status(401).json({ error: 'auth_required' });
  }
  const arr = loadUserArt(key);
  const next = arr.filter((a) => a.id !== req.params.id);
  saveUserArt(key, next);
  res.json({ ok: true, count: next.length, max: MAX_SAVES });
});

// ---- Admin + moderation ---------------------------------------------------
// Admin key: prefer ADMIN_KEY from the environment; otherwise a persisted random
// key in a 0600 file. It is NEVER printed to logs (stdout ends up in shared
// deploy/CI logs) and never ships in the client bundle — read it from the file
// on this machine if you need it. The parent enters it once at /admin.
const ADMIN_KEY_FILE = join(DATA_DIR, '.admin-key');
let ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) {
  try { ADMIN_KEY = readFileSync(ADMIN_KEY_FILE, 'utf8').trim(); } catch { ADMIN_KEY = ''; }
}
if (!ADMIN_KEY) {
  ADMIN_KEY = randomBytes(12).toString('hex');
  try { writeFileSync(ADMIN_KEY_FILE, ADMIN_KEY, { mode: 0o600 }); } catch { /* ignore */ }
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
  const roomCode = String(room || '').toUpperCase().slice(0, 16);
  // Snapshot the room's recent chat so a moderator sees the conversation around
  // the report (last 20 lines; names + text, no profile ids on the wire).
  const liveRoom = rooms.get(roomCode);
  const chatContext = liveRoom
    ? (liveRoom.chat || []).slice(-20).map((c) => ({ name: c.user.name, message: c.message, ts: c.ts }))
    : [];
  const report = {
    id: 'rep_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    room: roomCode,
    reason: String(reason || '').slice(0, 300),
    reporterName: String(reporterName || 'anonymous').slice(0, 20),
    source: source === 'auto' ? 'auto' : 'user',
    chatContext,
    ts: Date.now(),
    status: 'open',
  };
  // Urgency triage: keywords that suggest grooming/CSAM/self-harm/contact-sharing
  // float the report to the very front of the admin queue and get flagged.
  const haystack = `${report.reason} ${chatContext.map((c) => c.message).join(' ')}`.toLowerCase();
  report.urgent = /\b(sexual|nude|naked|nsfw|porn|meet\s?up|meet me|address|phone|snap(chat)?|kik|discord|instagram|insta|tiktok|kill|suicide|self.?harm|groom)\b/.test(haystack);
  if (report.urgent) {
    reports.unshift(report); // already newest-first; keep it at the top explicitly
  } else {
    reports.unshift(report);
  }
  // Keep urgent reports pinned above non-urgent within the cap.
  reports.sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0) || b.ts - a.ts);
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
  // Header only — never a query param, which would land the key in proxy/CDN
  // access logs and browser history (same leak class as tokens in WS URLs).
  const key = req.get('x-admin-key');
  if (!key || typeof ADMIN_KEY !== 'string' || !ADMIN_KEY) return false;
  const a = Buffer.from(String(key));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}
function adminGuard(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

// Anyone can file a report (no auth) — that's the point. But the queue is a
// bounded store, so rate-limit per IP so a flooder can't push real reports out
// the end of it. The cap is loose enough for a kid legitimately reporting a
// pile-on (12 per 10 minutes).
app.post('/api/report', (req, res) => {
  const { room, reason, reporterName } = req.body || {};
  if (!room) {
    return res.status(400).json({ error: 'room required' });
  }
  if (!rateOk(`report:${clientIp(req)}`, 12, 10 * 60_000)) {
    return res.status(429).json({ error: 'slow_down' });
  }
  const report = fileReport({ room, reason, reporterName, source: 'user' });
  // Give the reporter a real receipt so a kid knows it went through.
  res.json({ ok: true, received: true, urgent: !!report.urgent });
});

// Erasure: scrub a user's chat from the durable audit logs (COPPA/GDPR "delete
// my data"). Called by the client during account deletion while the token is
// still valid. Redacts by the opaque profileId — the only stable identifier the
// audit log keeps — replacing name + message with '[deleted]'.
app.post('/api/account/scrub-chat', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const identity = token ? await verifyAccessToken(token) : null;
  if (!identity || !identity.profileId) return res.status(401).json({ error: 'unauthorized' });
  const pid = identity.profileId;
  let scrubbed = 0;
  // 1) durable audit logs
  let files = [];
  try { files = readdirSync(CHAT_LOG_DIR).filter((f) => f.endsWith('.jsonl')); } catch { files = []; }
  for (const f of files) {
    const path = join(CHAT_LOG_DIR, f);
    let lines;
    try { lines = readFileSync(path, 'utf8').split('\n'); } catch { continue; }
    let changed = false;
    const out = lines.map((line) => {
      if (!line.trim()) return line;
      let e;
      try { e = JSON.parse(line); } catch { return line; }
      if (e && e.profileId === pid && e.message !== '[deleted]') {
        e.name = '[deleted]';
        e.message = '[deleted]';
        changed = true;
        scrubbed += 1;
        return JSON.stringify(e);
      }
      return line;
    });
    if (changed) {
      try { writeFileSync(path, out.join('\n')); } catch { /* best effort */ }
    }
  }
  // 2) in-memory chat buffers of any live room where this profile is connected
  for (const room of rooms.values()) {
    const sessionIds = new Set(
      Array.from(room.users.values()).filter((u) => u.profileId === pid).map((u) => u.id),
    );
    // Tapback membership keys are pb_<profileId> — erase them in EVERY room,
    // whether or not this profile has a live session there.
    const reactKey = `pb_${pid}`;
    let roomTouched = false;
    for (const c of room.chat || []) {
      if (c.reactions) {
        for (const [emoji, list] of Object.entries(c.reactions)) {
          const at = list.indexOf(reactKey);
          if (at >= 0) {
            list.splice(at, 1);
            if (!list.length) delete c.reactions[emoji];
            roomTouched = true;
          }
        }
      }
    }
    if (sessionIds.size) {
      const scrubbedIds = new Set();
      for (const c of room.chat || []) {
        if (c.user && sessionIds.has(c.user.id)) {
          c.user.name = '[deleted]';
          c.message = '[deleted]';
          if (c.id != null) scrubbedIds.add(c.id);
          roomTouched = true;
        }
      }
      // Replies embed a VALUE COPY of the quoted name + snippet — redact those
      // copies too, or the deleted child's words keep shipping to every joiner
      // inside other kids' reply lines.
      for (const c of room.chat || []) {
        if (c.replyTo && scrubbedIds.has(c.replyTo.id)) {
          c.replyTo = { id: c.replyTo.id, name: '[deleted]', snippet: '[deleted]' };
          roomTouched = true;
        }
      }
    }
    if (roomTouched) persistRoom(room.code);
  }
  const analyticsScrubbed = analyticsScrubProfile(pid);
  // 3) the account's SAVED ARTWORK — a deleted child's drawings must not linger
  //    on disk (COPPA erasure). Their gallery is one file keyed by the account.
  let artScrubbed = 0;
  try {
    const artFile = userArtFile(`pb_${pid}`);
    if (existsSync(artFile)) { unlinkSync(artFile); artScrubbed = 1; }
  } catch { /* best effort */ }
  // 4) the account's FRIDGE WALL posts (metadata + frame images).
  let wallScrubbed = 0;
  const accountKey = sanitizeKey(`pb_${pid}`);
  for (const post of [...wallPosts.values()]) {
    if (post.ownerKey === accountKey) { deleteWallPost(post.id); wallScrubbed += 1; }
  }
  res.json({ ok: true, scrubbed, analyticsScrubbed, artScrubbed, wallScrubbed });
});

app.get('/api/admin/check', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json({ ok: true });
});

app.get('/api/admin/analytics', (req, res) => {
  if (!adminGuard(req, res)) return;
  res.json(analyticsSnapshot());
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

// Moderator view of a room's chat audit log (durable, with profile ids).
app.get('/api/admin/rooms/:id/chat', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = String(req.params.id).toUpperCase().replace(/[^A-Z0-9_-]/gi, '').slice(0, 32);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  let lines = [];
  try {
    lines = readFileSync(chatLogFile(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    lines = [];
  }
  res.json({ room: id, chat: lines });
});

app.post('/api/admin/rooms/:id/clear', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = String(req.params.id).toUpperCase().slice(0, 16);
  const room = rooms.get(id);
  if (room) {
    room.lastCleared = room.history;
    room.lastClearedFrameId = null;
    room.history = [];
    recountFrameOps(room);
    analyticsRecordClear(id, null, 'admin');
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

// ---- The Fridge Wall: community gallery ------------------------------------
// Kids pin finished drawings to a public wall: title + tags (profanity-gated),
// hearts (one per person, toggle), search, and animated posts (up to 8 frame
// PNGs the client captured — the wall cycles them). Metadata and frames are
// stored in SEPARATE files so a vote never rewrites hundreds of KB of images.
const WALL_DIR = process.env.WALL_DIR || join(DATA_DIR, '.wall');
const MAX_WALL_POSTS = Number(process.env.MAX_WALL_POSTS || 500);
const WALL_FRAME_LIMIT = 8;
const WALL_FRAME_MAX_CHARS = 300_000; // ~220KB decoded per frame
const WALL_HIDE_REPORTS = Number(process.env.WALL_HIDE_REPORTS || 3); // distinct reporters to auto-hide
const WALL_MAX_VOTES = 100_000; // cap distinct hearts stored per post (disk bound)

// Only real raster images may be posted. SVG is deliberately EXCLUDED: it is an
// executable document, and serving it same-origin would be stored XSS. Every
// value here is a fixed, safe Content-Type we control (never echoed from input).
const WALL_IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// Sniff the decoded bytes — the data-URL's claimed MIME is not trusted. Returns
// a safe Content-Type from the allowlist, or null (reject / 404).
function sniffWallImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp';
  return null;
}

// Decode a raster-image data URL to {mime, buffer}, or null if it isn't one we
// accept (SVG, non-image, or bytes that don't match a known image header).
function decodeWallFrame(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > WALL_FRAME_MAX_CHARS) return null;
  const m = /^data:image\/([a-z+]+);base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m || !WALL_IMAGE_MIME[m[1].toLowerCase()]) return null; // svg+xml etc. rejected here
  let buffer;
  try { buffer = Buffer.from(m[2], 'base64'); } catch { return null; }
  const mime = sniffWallImage(buffer);
  return mime ? { mime, buffer } : null;
}

const wallPosts = new Map(); // id -> meta (frames live on disk only)

// Post ids are minted server-side as wp_<base36>. Validate before any id ever
// reaches the filesystem so a crafted :id can't traverse out of WALL_DIR.
function safeWallId(id) {
  return typeof id === 'string' && /^wp_[a-z0-9]{1,40}$/i.test(id) ? id : null;
}
function wallMetaFile(id) { return join(WALL_DIR, `${id}.json`); }
function wallFramesFile(id) { return join(WALL_DIR, `${id}.frames.json`); }

function loadWallPosts() {
  let files = [];
  try { files = readdirSync(WALL_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.frames.json')); } catch { return; }
  for (const f of files) {
    try {
      const meta = JSON.parse(readFileSync(join(WALL_DIR, f), 'utf8'));
      if (meta && safeWallId(meta.id)) wallPosts.set(meta.id, meta);
    } catch { /* one corrupt post never blocks the wall */ }
  }
}
loadWallPosts();

// Atomic write (temp + rename) so a crash/ENOSPC mid-write can't leave a
// truncated JSON file that loadWallPosts would silently drop.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function persistWallMeta(meta) {
  if (!safeWallId(meta.id)) return;
  mkdirSync(WALL_DIR, { recursive: true });
  writeFileAtomic(wallMetaFile(meta.id), JSON.stringify(meta));
}

function deleteWallPost(id) {
  if (!safeWallId(id)) return;
  wallPosts.delete(id);
  try { unlinkSync(wallMetaFile(id)); } catch { /* gone */ }
  try { unlinkSync(wallFramesFile(id)); } catch { /* gone */ }
}

// The app sits behind a Cloudflare tunnel, so req.ip is the tunnel's (constant)
// address — using it as an identity would collapse every anonymous visitor into
// ONE. Cloudflare puts the real client IP in CF-Connecting-IP (it overwrites any
// client-sent value, so it can't be spoofed through the tunnel); fall back to
// req.ip for local/dev where that header is absent.
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip || 'anon';
}

// Same intent as clientIp, but for the RAW upgrade request in the WS handler
// (an http.IncomingMessage — no Express .get()/.ip). Header-based only.
function rawClientIp(req) {
  return (req.headers && req.headers['cf-connecting-ip'])
    || (req.socket && req.socket.remoteAddress)
    || 'anon';
}

// Voter identity on a post is a salted hash — the meta file never stores raw
// device/account keys where a leak would link art to identities.
function wallVoterHash(key) {
  return createHash('sha256').update(`wall-vote:${key}`).digest('hex').slice(0, 16);
}

function sanitizeWallTag(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function publicWallPost(meta, viewerHash) {
  const parent = meta.parentPostId ? wallPosts.get(meta.parentPostId) : null;
  return {
    id: meta.id,
    title: meta.title,
    tags: meta.tags,
    artist: meta.artist,
    votes: Object.keys(meta.votedBy || {}).length,
    frames: meta.frameCount,
    durationMs: meta.durationMs,
    createdAt: meta.createdAt,
    liked: viewerHash ? Boolean((meta.votedBy || {})[viewerHash]) : false,
    allowRemix: meta.allowRemix === true,
    parentPostId: meta.parentPostId || null,
    rootPostId: meta.rootPostId || null,
    parent: parent && !parent.hidden ? { id: parent.id, title: parent.title } : null,
  };
}

// Deterministic within a day, different every day: the "fresh mix" order.
function dailyShuffle(arr) {
  const day = Math.floor(Date.now() / 86_400_000);
  const a = arr.slice();
  let seed = (day * 2654435761) % 2 ** 31;
  for (let i = a.length - 1; i > 0; i -= 1) {
    seed = (seed * 48271) % 2147483647;
    const j = seed % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Feed. `sort`: fresh (daily shuffle, default) | top (hearts) | new.
// The Daily Challenge: today's prompt, when the next one lands, and how many
// entries hang in today's gallery. Everything is derived (date-seeded), so this
// is stateless and always agrees with the DAILY room + the wall tags.
app.get('/api/daily', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  ensureDailyFresh(); // day flips on contact, not on the next 60s tick
  const c = dailyChallenge();
  let entries = 0;
  for (const p of wallPosts.values()) {
    if (!p.hidden && p.challenge === c.date) entries += 1;
  }
  res.json({ ...c, entries });
});

// ---- Weekly event nights ---------------------------------------------------
// Derived purely from the date (like the daily challenge): no state, no cron,
// and every client agrees on the schedule. An "event" is a coordination beacon
// into an always-open featured room — the room doesn't gate anything, the
// calendar just gives everyone a reason to show up at the same place on the
// same day. UTC day-of-week keeps it deterministic worldwide.
const WEEKLY_EVENTS = [
  { dow: 0, room: 'VIBES', emoji: '🌈', title: 'Cozy Sunday', blurb: 'Slow doodles, soft colors, zero pressure.' },
  { dow: 1, room: 'MEMEWALL', emoji: '🎭', title: 'Meme Monday', blurb: 'Redraw a meme from memory — chaos welcome.' },
  { dow: 2, room: 'OCCORNER', emoji: '🐲', title: 'OC Tuesday', blurb: 'Bring your character. Draw them into each other’s scenes.' },
  { dow: 3, room: 'FLIPBOOK', emoji: '🎬', title: 'Wiggle Wednesday', blurb: 'Group animation night — one loop, many hands.' },
  { dow: 4, room: 'GUESS', emoji: '🎮', title: 'Guess-a-thon Thursday', blurb: 'Draw & Guess marathon. Fastest scribbles win.' },
  { dow: 5, room: 'PHONE', emoji: '📞', title: 'Draw Phone Friday', blurb: 'Telephone with doodles. The drift is the fun.' },
  { dow: 6, room: 'GRAFFITI', emoji: '🧱', title: 'Saturday Mural', blurb: 'One giant wall. Paint your piece of it.' },
];

app.get('/api/events', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = new Date();
  const events = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const ev = WEEKLY_EVENTS[d.getUTCDay()];
    const room = rooms.get(ev.room);
    events.push({
      date: d.toISOString().slice(0, 10),
      today: i === 0,
      room: ev.room,
      emoji: ev.emoji,
      title: ev.title,
      blurb: ev.blurb,
      roomTitle: room ? room.title : null,
      live: room ? room.users.size : 0,
    });
  }
  res.json({ events });
});

// `q` searches title+tags+artist; `tag` filters exactly. Hidden posts (report
// threshold / admin) never leave the server.
app.get('/api/wall', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Viewer identity MUST match how a vote is recorded (account, else IP) so the
  // heart the viewer just tapped shows as filled on their next feed load.
  const viewerHash = wallVoterHash(await wallVoterIdentity(req).catch(() => `ip:${req.ip || 'anon'}`));
  const q = String(req.query.q || '').toLowerCase().trim();
  const tag = sanitizeWallTag(req.query.tag || '');
  const sort = ['top', 'new', 'fresh'].includes(req.query.sort) ? req.query.sort : 'fresh';
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 40));
  // Daily Challenge gallery: filter to posts stamped with one challenge date.
  const challenge = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.challenge || '')) ? String(req.query.challenge) : null;

  let list = [...wallPosts.values()].filter((p) => !p.hidden);
  if (challenge) list = list.filter((p) => p.challenge === challenge);
  if (tag) list = list.filter((p) => p.tags.includes(tag));
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = `${p.title} ${p.tags.join(' ')} ${p.artist}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }
  if (sort === 'top') {
    list.sort((a, b) => Object.keys(b.votedBy || {}).length - Object.keys(a.votedBy || {}).length || b.createdAt - a.createdAt);
  } else if (sort === 'new') {
    list.sort((a, b) => b.createdAt - a.createdAt);
  } else {
    list = dailyShuffle(list);
  }
  const total = list.length;
  const posts = list.slice(offset, offset + limit).map((p) => publicWallPost(p, viewerHash));
  // Popular tags power the chip row client-side (from the WHOLE wall, not the page).
  const tagCounts = {};
  for (const p of wallPosts.values()) {
    if (p.hidden) continue;
    for (const t of p.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
  res.json({ posts, total, topTags });
});

// Frames are immutable once posted — serve decoded bytes with long caching.
app.get('/api/wall/:id/frame/:n', (req, res) => {
  const meta = wallPosts.get(req.params.id);
  const n = Number(req.params.n);
  if (!meta || meta.hidden || !Number.isInteger(n) || n < 0 || n >= meta.frameCount) {
    return res.status(404).json({ error: 'not found' });
  }
  let frames;
  try {
    frames = JSON.parse(readFileSync(wallFramesFile(meta.id), 'utf8'));
  } catch {
    return res.status(404).json({ error: 'not found' });
  }
  // Re-sniff on the way out and emit a Content-Type WE choose (never echoed
  // from the stored URL), plus nosniff + a lockdown CSP. Even if a bad frame
  // ever reached disk, the browser can't be tricked into running it.
  const decoded = decodeWallFrame(frames[n]);
  if (!decoded) {
    return res.status(404).json({ error: 'not found' });
  }
  res.set('Content-Type', decoded.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.set('Cache-Control', 'public, max-age=86400, immutable');
  res.send(decoded.buffer);
});

// One post, by id — powers the /wall/:id deep link (share a drawing with a
// friend and it opens on exactly that card, with its own OG preview).
app.get('/api/wall/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const meta = wallPosts.get(req.params.id);
  if (!meta || meta.hidden) return res.status(404).json({ error: 'not found' });
  const viewerHash = wallVoterHash(await wallVoterIdentity(req).catch(() => `ip:${req.ip || 'anon'}`));
  res.json({ post: publicWallPost(meta, viewerHash) });
});

// Start a fresh private room from an opt-in Wall post. The server derives and
// persists the source so a collaborator/reconnect cannot forge or lose lineage.
app.post('/api/wall/:id/remix-room', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const source = wallPosts.get(req.params.id);
  if (!source || source.hidden || source.allowRemix !== true) {
    return res.status(404).json({ error: 'not_remixable' });
  }
  const ip = clientIp(req);
  if (!rateOk(`remix-room:${ip}`, 8, 10 * 60_000)) {
    return res.status(429).json({ error: 'slow_down' });
  }
  const code = genRoomCode();
  const room = getRoom(code);
  room.audience = 'friends';
  room.listed = false;
  room.title = `Remix: ${source.title}`.slice(0, 40);
  room.remixSource = {
    id: source.id,
    rootPostId: source.rootPostId || source.id,
    title: source.title,
  };
  room.sheetId = `remix:${source.id}`;
  persistRoom(code);
  res.json({ code, remixSource: room.remixSource });
});

app.post('/api/wall', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ownerKey = await resolveArtOwner(req);
  if (!ownerKey) {
    return res.status(401).json({ error: 'auth_required' });
  }
  const ip = clientIp(req);
  // Per-account/device cap stays tight (3/10min); the per-IP cap is looser
  // because a classroom or family behind one NAT is many legitimate posters.
  if (!rateOk(`wallpost:${ownerKey}`, 3, 10 * 60_000) || !rateOk(`wallpost:ip:${ip}`, 40, 10 * 60_000)) {
    return res.status(429).json({ error: 'slow_down' });
  }
  const body = req.body || {};
  const title = String(body.title || 'My drawing').replace(/\s+/g, ' ').trim().slice(0, 60) || 'My drawing';
  const rawTags = Array.isArray(body.tags) ? body.tags.slice(0, 5) : [];
  const tags = [...new Set(rawTags.map(sanitizeWallTag).filter(Boolean))];
  // Posts made from the Daily Challenge room join today's gallery: stamp the
  // challenge date + a browsable tag. Client-declared room — "spoofing" it just
  // means opting your art into today's gallery, which is harmless by design.
  const challengeDate = String(body.room || '').toUpperCase() === 'DAILY' ? dailyChallenge().date : null;
  if (challengeDate && !tags.includes('daily challenge')) tags.push('daily challenge');
  const frames = Array.isArray(body.frames) ? body.frames.slice(0, WALL_FRAME_LIMIT) : [];
  const durationMs = Math.min(2000, Math.max(80, Number(body.durationMs) || 400));
  // Every frame must decode to a real raster image (magic-byte checked). This
  // is what rejects SVG and any non-image payload before it ever touches disk.
  if (!frames.length || !frames.every((f) => decodeWallFrame(f) !== null)) {
    return res.status(400).json({ error: 'bad_frames' });
  }

  // The wall is for every kid — any flagged word in the text fields rejects
  // the post (mild included), and severe terms auto-file a report so the
  // admin sees who is probing the filter.
  let artist = '';
  const token = bearerToken(req);
  if (token) {
    const identity = await verifyAccessToken(token).catch(() => null);
    artist = identity?.displayName || '';
  }
  if (!artist) artist = String(body.artist || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!artist) artist = 'A Drawesome artist';
  for (const text of [title, artist, ...tags]) {
    const verdict = scan(text);
    if (verdict.hit) {
      if (verdict.severity === 'severe') {
        fileReport({ room: 'WALL', reason: `wall post rejected for language: "${text}"`, reporterName: 'wall-filter', source: 'auto' });
      }
      return res.status(400).json({ error: 'language' });
    }
  }
  let parentPost = null;
  const requestedParentId = safeWallId(body.parentPostId);
  if (requestedParentId) {
    parentPost = wallPosts.get(requestedParentId) || null;
    if (!parentPost || parentPost.hidden || parentPost.allowRemix !== true) {
      return res.status(400).json({ error: 'invalid_remix_source' });
    }
  }

  if (wallPosts.size >= MAX_WALL_POSTS) {
    // Prune the least-loved poster older than 48h to make room; a wall full of
    // fresh loved art rejects instead of eating someone's post silently.
    const cutoff = Date.now() - 48 * 3600_000;
    const candidates = [...wallPosts.values()].filter((p) => p.createdAt < cutoff);
    candidates.sort((a, b) =>
      Object.keys(a.votedBy || {}).length - Object.keys(b.votedBy || {}).length || a.createdAt - b.createdAt);
    if (!candidates.length) {
      return res.status(409).json({ error: 'wall_full' });
    }
    deleteWallPost(candidates[0].id);
  }

  const meta = {
    id: 'wp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title,
    tags,
    artist,
    ownerKey,
    createdAt: Date.now(),
    votedBy: {},
    reportedBy: {},
    frameCount: frames.length,
    durationMs,
    reports: 0,
    hidden: false,
    challenge: challengeDate, // 'YYYY-MM-DD' when posted from the DAILY room
    allowRemix: body.allowRemix === true,
    parentPostId: parentPost?.id || null,
    rootPostId: parentPost ? (parentPost.rootPostId || parentPost.id) : null,
  };
  mkdirSync(WALL_DIR, { recursive: true });
  writeFileAtomic(wallFramesFile(meta.id), JSON.stringify(frames));
  persistWallMeta(meta);
  wallPosts.set(meta.id, meta);
  res.json({ ok: true, id: meta.id });
});

// The voter identity is SERVER-DERIVED: a signed-in account, else the request
// IP. It is NOT the client-supplied device key — that is attacker-rotatable, so
// keying votes/throttle on it let one caller forge unlimited hearts and grow
// votedBy without bound. Both a per-identity and a per-IP cap apply.
async function wallVoterIdentity(req) {
  const token = bearerToken(req);
  if (token) {
    const identity = await verifyAccessToken(token).catch(() => null);
    if (identity?.profileId) return `pb_${identity.profileId}`;
  }
  return `ip:${clientIp(req)}`;
}

app.post('/api/wall/:id/vote', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const voterId = await wallVoterIdentity(req);
  const ip = clientIp(req);
  if (!rateOk(`wallvote:${voterId}`, 40, 60_000) || !rateOk(`wallvote:ip:${ip}`, 40, 60_000)) {
    return res.status(429).json({ error: 'slow_down' });
  }
  const meta = wallPosts.get(req.params.id);
  if (!meta || meta.hidden) {
    return res.status(404).json({ error: 'not found' });
  }
  const hash = wallVoterHash(voterId);
  meta.votedBy = meta.votedBy || {};
  const on = req.body?.on !== false;
  if (on) {
    // New distinct hearts are capped so votedBy (and the meta file) can't grow
    // without bound; existing voters can always re-affirm.
    if (!meta.votedBy[hash] && Object.keys(meta.votedBy).length >= WALL_MAX_VOTES) {
      return res.json({ ok: true, votes: Object.keys(meta.votedBy).length, liked: false });
    }
    meta.votedBy[hash] = 1;
  } else {
    delete meta.votedBy[hash];
  }
  persistWallMeta(meta);
  res.json({ ok: true, votes: Object.keys(meta.votedBy).length, liked: on });
});

app.post('/api/wall/:id/report', (req, res) => {
  const ip = clientIp(req);
  if (!rateOk(`wallreport:${ip}`, 5, 10 * 60_000)) {
    return res.status(429).json({ error: 'slow_down' });
  }
  const meta = wallPosts.get(req.params.id);
  if (!meta) {
    return res.status(404).json({ error: 'not found' });
  }
  // Auto-hide counts DISTINCT reporters (hashed IP), not raw clicks — otherwise
  // one person could bury any drawing by tapping report three times. Repeat
  // reports from the same IP are ignored for both the counter and the queue.
  meta.reportedBy = meta.reportedBy || {};
  const rhash = wallVoterHash(`report:${ip}`);
  if (meta.reportedBy[rhash]) {
    return res.json({ ok: true }); // already counted this reporter
  }
  meta.reportedBy[rhash] = 1;
  meta.reports = Object.keys(meta.reportedBy).length;
  if (meta.reports >= WALL_HIDE_REPORTS && !meta.hidden) {
    meta.hidden = true; // off the wall until an admin rules on it
  }
  persistWallMeta(meta);
  fileReport({
    room: 'WALL',
    reason: `[wall:${meta.id}] "${meta.title}" — ${String(req.body?.reason || 'reported').slice(0, 200)}`,
    reporterName: String(req.body?.reporterName || 'Anonymous').slice(0, 40),
    source: 'user',
  });
  res.json({ ok: true });
});

// A kid (or their parent, same device/account) can always take their art down.
app.delete('/api/wall/:id', async (req, res) => {
  const key = await resolveArtOwner(req);
  const meta = wallPosts.get(req.params.id);
  if (!meta) {
    return res.status(404).json({ error: 'not found' });
  }
  if (!key || meta.ownerKey !== key) {
    return res.status(403).json({ error: 'not_yours' });
  }
  deleteWallPost(meta.id);
  res.json({ ok: true });
});

app.get('/api/admin/wall', (req, res) => {
  if (!adminGuard(req, res)) return;
  const items = [...wallPosts.values()]
    .sort((a, b) => (b.hidden ? 1 : 0) - (a.hidden ? 1 : 0) || b.createdAt - a.createdAt)
    .map((p) => ({ ...publicWallPost(p, ''), hidden: p.hidden, reports: p.reports || 0, ownerKey: p.ownerKey }));
  res.json({ items });
});

app.post('/api/admin/wall/:id/delete', (req, res) => {
  if (!adminGuard(req, res)) return;
  // Only delete a post we actually know about — never let a crafted :id reach
  // the filesystem (deleteWallPost also validates the id shape as defence in
  // depth).
  if (!wallPosts.has(req.params.id)) {
    return res.status(404).json({ error: 'not found' });
  }
  deleteWallPost(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/wall/:id/restore', (req, res) => {
  if (!adminGuard(req, res)) return;
  const meta = wallPosts.get(req.params.id);
  if (meta) {
    meta.hidden = false;
    meta.reports = 0;
    // Clear the distinct-reporter set too — otherwise reports is recomputed from
    // it and a single new report instantly re-buries an admin-approved post.
    meta.reportedBy = {};
    persistWallMeta(meta);
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
// The wall's per-IP/per-voter buckets mint many short-lived keys; without a
// sweep createHits would grow unbounded. Every 5 min, drop keys whose newest
// hit is older than 10 min (past any window we use).
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, arr] of createHits) {
    if (!arr.length || arr[arr.length - 1] < cutoff) createHits.delete(key);
  }
}, 5 * 60_000).unref?.();

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
  const mode = typeof body.mode === 'string' ? body.mode : null;
  if (!['kid_safe', 'friends', 'adult_18'].includes(audience)) {
    return res.status(400).json({ error: 'bad_audience' });
  }
  if (audience === 'adult_18') {
    return res.status(403).json({ error: 'adult_disabled' });
  }
  if (mode && mode !== 'storybook') {
    return res.status(400).json({ error: 'bad_mode' });
  }
  if (mode === 'storybook' && audience !== 'friends') {
    return res.status(400).json({ error: 'storybook_private_only' });
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
  if (mode === 'storybook') {
    room.title = room.title || 'Our Story';
    enableStorybookRoom(room);
  }
  persistRoom(code);
  res.json({ code, audience: room.audience, listed: room.listed, title: room.title, mode });
});

// One segment's complete film data for the client-side production exporter:
// scene metadata + every visible op, replayed offline through the shared op
// interpreter. Animation rooms only. Access model matches invites: knowing
// the room code = being in the crew. Never materializes rooms for probes.
app.get('/api/rooms/:code/film', (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Serializing a whole segment's history is a heavy, event-loop-blocking
  // sync stringify (up to MAX_ANIM_ROOM_OPS ops). FLIPBOOK's code is public, so
  // gate per-IP or an anon client could loop this and jank every live canvas.
  if (!rateOk(`film:${req.ip || 'anon'}`)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9_-]/gi, '').slice(0, 16);
  if (!code || (!rooms.has(code) && !existsSync(roomFile(code)))) {
    return res.status(404).json({ error: 'not_found' });
  }
  const room = getRoom(code);
  if (!room.animationEnabled) {
    return res.status(404).json({ error: 'not_a_film' });
  }
  res.json({ code, title: room.title || null, scenes: scenesMeta(room), ops: visibleHistory(room) });
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
      ops: room.history.length, // "things done" — drawn ops, for the join modal
      // NEVER leak a trace-photo id here: the id is the access token, so an
      // unauthenticated lobby scrape must not expose a room's uploaded photo.
      sheetId: room.sheetId && !room.sheetId.startsWith('trace_') && !room.sheetId.startsWith('pp_') ? room.sheetId : null,
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
  // User trace photos ride the same route (id "trace_…") so the client loader
  // needs no new branch.
  if (req.params.id.startsWith('trace_')) {
    const photo = tracePhotos.get(req.params.id);
    if (!photo) return res.status(404).json({ error: 'not found' });
    return res.json({ id: req.params.id, name: 'Trace photo', image: photo.image });
  }
  // Draw Phone pages ride the same route (id "pp_…") — the id is an unguessable
  // token handed only to the next guesser (and, at reveal, the whole room).
  if (req.params.id.startsWith('pp_')) {
    const page = phonePages.get(req.params.id);
    if (!page) return res.status(404).json({ error: 'not found' });
    return res.json({ id: req.params.id, name: 'Draw Phone page', image: page.image });
  }
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

// Takedown for a reported trace photo: delete the image AND clear it from
// whichever live room is displaying it (broadcasting sheet:null to everyone).
app.post('/api/admin/trace/:id/remove', (req, res) => {
  if (!adminGuard(req, res)) return;
  const id = req.params.id;
  tracePhotos.delete(id);
  for (const [code, room] of rooms) {
    if (room.sheetId === id) {
      room.sheetId = null;
      broadcast(code, { type: 'sheet', sheetId: null });
      persistRoom(code);
    }
  }
  res.json({ ok: true });
});

// ---- Trace-a-photo -------------------------------------------------------
// A user-uploaded photo becomes the room's traced underlay for everyone. Held
// in memory only (ephemeral, capped) and served through the SAME /api/sheets
// path so the client's loadSheetImage needs no new branch. SAFETY: uploads are
// host-gated in owned rooms and blocked in the hostless public rooms (see the
// set_trace_photo WS handler); the payload is validated to be a real raster
// image (never SVG/scripts) here.
const tracePhotos = new Map(); // id -> { image, roomId, ts }
const TRACE_MAX = 240;
const TRACE_MAX_CHARS = 2_400_000; // ~1.8MB decoded photo

// Decode a raster data URL to a data URL we trust, or null. Reuses the wall's
// magic-byte sniff so SVG / non-image / mismatched bytes are rejected.
function validateTracePhoto(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > TRACE_MAX_CHARS) return null;
  const m = /^data:image\/([a-z+]+);base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m || !WALL_IMAGE_MIME[m[1].toLowerCase()]) return null; // svg+xml etc. rejected
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  return sniffWallImage(buf) ? dataUrl : null; // real PNG/JPEG/GIF/WEBP header required
}

function storeTracePhoto(roomId, dataUrl) {
  // A long RANDOM id — the id IS the access token (only room members ever
  // receive it via the sheet broadcast), so it must be unguessable and never
  // leaked in the public lobby (see the /api/rooms/public sanitize).
  const id = 'trace_' + randomBytes(12).toString('hex');
  tracePhotos.set(id, { image: dataUrl, roomId, ts: Date.now() });
  // Cap so a busy server can't accumulate photos forever — but NEVER evict a
  // photo that is some live room's active underlay.
  if (tracePhotos.size > TRACE_MAX) {
    const active = new Set();
    for (const r of rooms.values()) if (r.sheetId && r.sheetId.startsWith('trace_')) active.add(r.sheetId);
    for (const key of tracePhotos.keys()) {
      if (tracePhotos.size <= TRACE_MAX) break;
      if (key !== id && !active.has(key)) tracePhotos.delete(key);
    }
  }
  return id;
}

// Drop a room's current trace photo (on replace / clear / close) so old images
// don't linger fetchable and orphans don't fill the cap.
function dropRoomTracePhoto(room) {
  if (room && room.sheetId && room.sheetId.startsWith('trace_')) {
    tracePhotos.delete(room.sheetId);
  }
}

// ---- Draw Phone page images ----------------------------------------------
// A player's drawn page (a downscaled PNG/JPEG) is held in memory, keyed by an
// unguessable id, and served through the SAME /api/sheets path (id "pp_…") so
// the client just loads it like a sheet. Pages are validated exactly like trace
// photos (real raster only — never SVG/scripts) and freed when the game ends or
// the room closes; ids are never leaked in the public lobby (room.sheetId is
// null during a game). One image only ever reaches its next guesser until the
// reveal, when the whole room sees the books.
const phonePages = new Map(); // id -> { image, roomId, ts }
const PHONE_PAGE_MAX = 800; // ~ a few full games' worth of pages
const PHONE_PAGE_MAX_CHARS = 900_000; // a downscaled page, well under a photo

function validatePhonePage(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > PHONE_PAGE_MAX_CHARS) return null;
  const m = /^data:image\/([a-z+]+);base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
  if (!m || !WALL_IMAGE_MIME[m[1].toLowerCase()]) return null; // svg+xml etc. rejected
  let buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch { return null; }
  return sniffWallImage(buf) ? dataUrl : null;
}

// The set of page ids belonging to any room's LIVE game — never evicted.
function livePhonePageIds() {
  const active = new Set();
  for (const r of rooms.values()) {
    if (!r.phone || !Array.isArray(r.phone.books)) continue;
    for (const b of r.phone.books) for (const pg of b.pages) {
      if (pg.type === 'draw' && typeof pg.content === 'string' && pg.content.startsWith('pp_')) active.add(pg.content);
    }
  }
  return active;
}

function storePhonePage(roomId, dataUrl) {
  const id = 'pp_' + randomBytes(12).toString('hex'); // unguessable — the id is the token
  phonePages.set(id, { image: dataUrl, roomId, ts: Date.now() });
  if (phonePages.size > PHONE_PAGE_MAX) {
    const active = livePhonePageIds();
    for (const key of phonePages.keys()) {
      if (phonePages.size <= PHONE_PAGE_MAX) break;
      if (key !== id && !active.has(key)) phonePages.delete(key);
    }
  }
  return id;
}

// Free every page image a room's game produced (on stop / reveal-end / close).
function dropRoomPhonePages(room) {
  if (!room || !room.phone || !Array.isArray(room.phone.books)) return;
  for (const b of room.phone.books) for (const pg of b.pages) {
    if (pg.type === 'draw' && typeof pg.content === 'string' && pg.content.startsWith('pp_')) phonePages.delete(pg.content);
  }
}

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

// ---- Route-aware <head> (the SPA's "linker pass") -------------------------
// The built shell is one HTML file, but the tags that matter to crawlers and
// chat-app preview bots are marked with data-seo attributes (see index.html).
// Instead of SSR, we treat the shell as an object file and relink its head per
// route at serve time: per-room invite cards, per-post wall art cards, real
// titles on every page. Costs a few string replaces per HTML request — zero
// impact on the drawing hot path.
const SITE_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://drawesome.art';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderShell(shell, over = {}) {
  let html = shell;
  // Every replacement below uses a FUNCTION replacement, never a string one:
  // string replacements interpret `$&`/`$'` sequences, so a kid-entered title
  // containing `$` would splice shell fragments into the head.
  const setTag = (marker, attr, value) => {
    if (value == null) return;
    const re = new RegExp(`<([a-z]+)([^>]*data-seo="${marker}"[^>]*)>`, 'i');
    html = html.replace(re, (tag) =>
      tag.replace(new RegExp(`${attr}="[^"]*"`), () => `${attr}="${escapeHtml(value)}"`));
  };
  if (over.title != null) {
    html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/, () => `<title data-seo="title">${escapeHtml(over.title)}</title>`);
    setTag('og:title', 'content', over.title);
    setTag('tw:title', 'content', over.title);
  }
  if (over.description != null) {
    setTag('desc', 'content', over.description);
    setTag('og:desc', 'content', over.description);
    setTag('tw:desc', 'content', over.description);
  }
  if (over.url != null) {
    setTag('og:url', 'content', over.url);
    setTag('canonical', 'href', over.url);
  }
  if (over.image != null) {
    setTag('og:image', 'content', over.image);
    setTag('tw:image', 'content', over.image);
  }
  if (over.type != null) setTag('og:type', 'content', over.type);
  if (over.jsonLd) {
    // Static, server-authored JSON-LD only. If user content ever flows in here,
    // it must be sanitized against `</script>` breakout first.
    html = html.replace('</head>', () => `<script type="application/ld+json">${JSON.stringify(over.jsonLd)}</script>\n</head>`);
  }
  return html;
}

// Static page titles/descriptions. Every entry becomes a distinct SERP result
// instead of eight copies of the homepage.
const PAGE_META = {
  '/studio': {
    title: 'Open studio — Drawesome',
    description: 'Jump straight into the studio and start drawing — brushes, layers, coloring sheets, and live rooms. Free, no account needed.',
  },
  '/rooms': {
    title: 'Live drawing rooms — Drawesome',
    description: "See what everyone is drawing right now and join a live room: open studio, Draw Phone, animation, daily challenge, and more.",
  },
  '/wall': {
    title: 'The Fridge Wall — Drawesome gallery',
    description: 'A community gallery of drawings by Drawesome artists. Heart your favorites, watch animated posts, and remix the ones you love.',
  },
  '/about': { title: 'About Drawesome', description: 'What Drawesome is, how rooms work, and why there are no ads and no real-money purchases.' },
  '/faq': {
    title: 'Safety & FAQ — Drawesome',
    description: 'How moderation works, what data we store, how to report, and house rules — written to match how the app actually works.',
  },
  '/safety': { title: 'Safety — Drawesome', description: 'How Drawesome keeps shared drawing spaces safe: auto-moderation in public rooms, reporting, host tools, and data care.' },
  '/parents': {
    title: 'Parents & teachers — Drawesome',
    description: 'The honest tour for grown-ups: how moderation works, what data we keep (and delete), age guidance, and how to host a classroom drawing session in two minutes.',
  },
  '/privacy': { title: 'Privacy — Drawesome', description: 'What Drawesome stores, what it never does with your data, and the choices you have — including full account erasure.' },
  '/signup': { title: 'Save your art — Drawesome', description: 'Make a free account to keep your gallery, wall posts, and streak across devices. Or keep drawing as a guest.' },
};

const FAQ_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Is Drawesome safe for kids and teens?',
      acceptedAnswer: { '@type': 'Answer', text: 'Public rooms are auto-moderated: chat is filtered, drawings are scanned, and every room has reporting plus host mute/kick tools. Private invite rooms are lighter-touch, and we say so up front.' },
    },
    {
      '@type': 'Question',
      name: 'Do I need an account?',
      acceptedAnswer: { '@type': 'Answer', text: 'No. You can draw, join rooms, and play games as a guest. An account only adds cross-device saving of your art and streak.' },
    },
    {
      '@type': 'Question',
      name: 'Does Drawesome have ads or in-app purchases?',
      acceptedAnswer: { '@type': 'Answer', text: 'No ads and no real-money purchases. The in-app currency is play money earned by drawing.' },
    },
    {
      '@type': 'Question',
      name: 'How do I report something?',
      acceptedAnswer: { '@type': 'Answer', text: 'Every room and every wall post has a report button. Reports go straight to the moderators, and urgent ones are triaged first. You can also email safety@drawesome.art.' },
    },
    {
      '@type': 'Question',
      name: 'Can I delete my data?',
      acceptedAnswer: { '@type': 'Answer', text: 'Yes — deleting your account wipes your saved art, wall posts, and chat history from our servers.' },
    },
  ],
};

// Head overrides for one request path, or null for the untouched default shell.
function seoOverridesFor(reqPath) {
  const path = reqPath.replace(/\/+$/, '') || '/';
  if (PAGE_META[path]) {
    const over = { ...PAGE_META[path], url: `${SITE_ORIGIN}${path}` };
    if (path === '/faq') over.jsonLd = FAQ_JSON_LD;
    return over;
  }
  const wallMatch = /^\/wall\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (wallMatch) {
    const post = wallPosts.get(wallMatch[1]);
    if (post && !post.hidden) {
      const hearts = Object.keys(post.votedBy || {}).length;
      return {
        title: `“${post.title}” by ${post.artist} — the Fridge Wall`,
        description: `A drawing on Drawesome's Fridge Wall${hearts ? ` with ${hearts} ❤️` : ''}${post.frameCount > 1 ? ' — it moves!' : ''}. See it, heart it, or remix it live.`,
        url: `${SITE_ORIGIN}/wall/${post.id}`,
        image: `${SITE_ORIGIN}/api/wall/${post.id}/frame/0`,
        type: 'article',
      };
    }
    return { ...PAGE_META['/wall'], url: `${SITE_ORIGIN}/wall` };
  }
  const joinMatch = /^\/join\/([A-Za-z0-9-]{1,16})$/.exec(path);
  if (joinMatch) {
    const code = joinMatch[1].toUpperCase();
    const room = rooms.get(code);
    // Public rooms get a real invite card. Private rooms stay opaque: the link
    // itself is the capability, so preview bots (and code guessers) never see a
    // kid-entered title or a headcount.
    if (room && room.audience === 'kid_safe' && room.listed) {
      const painting = room.users ? room.users.size : 0;
      return {
        title: `Join “${room.title || code}” on Drawesome 🎨`,
        description: `${painting > 0 ? `${painting} drawing right now — ` : ''}jump into this live drawing room. Free, no account needed.`,
        url: `${SITE_ORIGIN}/join/${code}`,
      };
    }
    return {
      title: "You're invited to draw on Drawesome 🎨",
      description: 'A friend wants to draw with you, live. Tap to join their room — free, no account needed.',
      url: `${SITE_ORIGIN}/join/${code}`,
    };
  }
  return null;
}

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /join/\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
  );
});

// Sitemap: the static pages plus the wall's newest posts (each has its own OG
// card, so they're real landing pages). /join/ links are deliberately absent —
// robots.txt disallows them so a leaked private invite never gets indexed.
app.get('/sitemap.xml', (_req, res) => {
  const urls = [];
  const add = (loc, changefreq, priority) => urls.push({ loc, changefreq, priority });
  add(`${SITE_ORIGIN}/`, 'daily', '1.0');
  for (const p of Object.keys(PAGE_META)) add(`${SITE_ORIGIN}${p}`, p === '/wall' || p === '/rooms' ? 'hourly' : 'weekly', '0.8');
  const posts = [...wallPosts.values()].filter((p) => !p.hidden).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
  for (const p of posts) add(`${SITE_ORIGIN}/wall/${p.id}`, 'weekly', '0.5');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${escapeHtml(u.loc)}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`)
    .join('\n')}\n</urlset>\n`;
  res.type('application/xml').setHeader('Cache-Control', 'public, max-age=3600').send(xml);
});

const distPath = join(__dirname, 'dist');
if (existsSync(distPath)) {
  // The shell is read once; deploys replace the container (or restart the
  // process), so an in-memory copy is always current.
  let shellHtml = '';
  try {
    shellHtml = readFileSync(join(distPath, 'index.html'), 'utf8');
  } catch {
    shellHtml = '';
  }
  // Vite emits content-hashed asset names, so a year of immutable edge/browser
  // caching is safe; only index.html (the pointer to the hashes) must revalidate.
  app.use(express.static(distPath, {
    maxAge: '1y',
    immutable: true,
    index: false,
    setHeaders: (res, p) => {
      if (p.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  // SPA fallback (Express 5: use middleware, not an app.get('*') route). Every
  // unmatched GET returns the shell — with its head relinked for the route —
  // so /studio, /join/CODE and /wall/POST work on direct load AND unfurl as
  // themselves in iMessage/Discord/WhatsApp.
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
    res.setHeader('Cache-Control', 'no-cache'); // shell must revalidate so new deploys land
    if (!shellHtml) {
      res.sendFile(join(distPath, 'index.html'));
      return;
    }
    const over = seoOverridesFor(req.path);
    res.type('html').send(over ? renderShell(shellHtml, over) : shellHtml);
  });
} else {
  app.use((_req, res) => res.status(503).send('Build missing. Run `npm run build` first.'));
}

server.listen(PORT, () => {
  console.log(`Drawesome server on http://localhost:${PORT}  (ws path /ws)`);
  // The admin key is intentionally NOT logged. Read it on this host from
  // ${ADMIN_KEY_FILE} (or set ADMIN_KEY in the environment).
  console.log(`Admin key: set via ADMIN_KEY env or read ${ADMIN_KEY_FILE} on the server host.`);
});

function shutdown() {
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
