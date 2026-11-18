// Site presence: who is on drawesome.art right now and over the last few hours.
//
// Why this exists next to the analytics in server.js: those count PAINTERS
// (sockets inside a room) and hourly buckets, so the admin page could not say
// how many people were on the site in the last 30 minutes, and anyone reading
// the homepage, the Wall, the coloring library or just watching a mural was
// invisible. This module keeps:
//
//   visitors  one row per device (sha1 of ip|user-agent, 16 chars, no PII):
//             last seen at all, last seen painting, last seen watching.
//   minutes   one bucket per minute for 36 hours:
//             [page loads, arrivals, room joins, strokes, chats, peak online]
//             where "arrivals" is a visit start (first request, or a return
//             after 30 quiet minutes) and "peak online" is the high-water
//             mark of painters + spectators during that minute.
//
// 36 hours covers "today so far" for an admin in any timezone. Everything is
// bounded, persisted (debounced) under DATA_DIR so a restart keeps the day,
// and cheap: a mark is a Map lookup, a count is an array increment.
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const MINUTE_MS = 60_000;
export const RETAIN_MS = 36 * 60 * MINUTE_MS;
export const VISIT_GAP_MS = 30 * MINUTE_MS;

// Visitor kinds (what the device was doing).
export const KIND_PAGE = 1; // any browser request: a page, an API poll, a mention watcher
export const KIND_PAINT = 2; // a member socket inside a room
export const KIND_WATCH = 4; // a read-only spectator socket

// Minute-bucket fields.
export const F_VIEWS = 0;
export const F_ARRIVALS = 1;
export const F_JOINS = 2;
export const F_STROKES = 3;
export const F_CHATS = 4;
export const F_PEAK = 5;
const FIELD_COUNT = 6;

const VISITOR_CAP = Number(process.env.PRESENCE_VISITOR_CAP || 50_000);
const PERSIST_DELAY_MS = 15_000;

export function hashVisitor(ip, ua) {
  return createHash('sha1').update(`${ip || ''}|${ua || ''}`).digest('base64').slice(0, 16);
}

export function createPresence({ dataDir, now = Date.now, persist = true } = {}) {
  const file = dataDir ? join(dataDir, '.presence.json') : null;
  // hash -> { l: lastSeen, p: lastPaint, w: lastWatch, s: staff (excluded) }
  let visitors = new Map();
  // minuteIndex -> number[FIELD_COUNT]
  let minutes = new Map();
  let persistTimer = null;

  function load() {
    if (!file || !persist) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const cutoff = now() - RETAIN_MS;
      for (const row of Array.isArray(raw.visitors) ? raw.visitors : []) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        const l = Number(row[1]) || 0;
        if (l < cutoff) continue;
        visitors.set(row[0], { l, p: Number(row[2]) || 0, w: Number(row[3]) || 0, s: row[4] === 1 });
      }
      for (const row of Array.isArray(raw.minutes) ? raw.minutes : []) {
        if (!Array.isArray(row) || row.length < 1 + FIELD_COUNT) continue;
        const m = Number(row[0]);
        if (!Number.isFinite(m) || m * MINUTE_MS < cutoff) continue;
        minutes.set(m, row.slice(1, 1 + FIELD_COUNT).map((v) => Math.max(0, Number(v) || 0)));
      }
    } catch {
      // No file yet, or unreadable: start empty. Presence must never block boot.
    }
  }

  function persistNow() {
    persistTimer = null;
    if (!file || !persist) return;
    prune();
    try {
      writeFileSync(file, JSON.stringify({
        version: 1,
        visitors: [...visitors.entries()].map(([h, v]) => [h, v.l, v.p, v.w, v.s ? 1 : 0]),
        minutes: [...minutes.entries()].map(([m, b]) => [m, ...b]),
      }));
    } catch {
      // Disk trouble must not break painting; the next debounce retries.
    }
  }

  function schedulePersist() {
    if (persistTimer || !persist) return;
    persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
    if (persistTimer.unref) persistTimer.unref();
  }

  function prune(t = now()) {
    const cutoff = t - RETAIN_MS;
    for (const [h, v] of visitors) if (v.l < cutoff) visitors.delete(h);
    const minCutoff = Math.floor(cutoff / MINUTE_MS);
    for (const m of minutes.keys()) if (m < minCutoff) minutes.delete(m);
  }

  function bucket(t = now()) {
    const m = Math.floor(t / MINUTE_MS);
    let b = minutes.get(m);
    if (!b) {
      b = new Array(FIELD_COUNT).fill(0);
      minutes.set(m, b);
      if (minutes.size > (RETAIN_MS / MINUTE_MS) + 60) prune(t);
    }
    return b;
  }

  // A device was seen doing `kind` at time t.
  function mark(hash, kind = KIND_PAGE, t = now()) {
    if (!hash) return;
    let v = visitors.get(hash);
    if (!v) {
      if (visitors.size >= VISITOR_CAP) prune(t);
      if (visitors.size >= VISITOR_CAP) return;
      v = { l: 0, p: 0, w: 0, s: false };
      visitors.set(hash, v);
    }
    if (!v.s && t - v.l > VISIT_GAP_MS) bucket(t)[F_ARRIVALS] += 1;
    if (t > v.l) v.l = t;
    if (kind & KIND_PAINT && t > v.p) v.p = t;
    if (kind & KIND_WATCH && t > v.w) v.w = t;
    schedulePersist();
  }

  // The device behind an authenticated admin request is staff: it is dropped
  // from every visitor count from now on (the console's own polling and the
  // moderator's browsing would otherwise show up as a visitor).
  function markStaff(hash, t = now()) {
    if (!hash) return;
    const v = visitors.get(hash);
    if (v) {
      v.s = true;
      if (t > v.l) v.l = t;
    } else if (visitors.size < VISITOR_CAP) {
      visitors.set(hash, { l: t, p: 0, w: 0, s: true });
    }
    schedulePersist();
  }

  // Something happened n times (a page load, a join, a stroke, a chat).
  function count(field, n = 1, t = now()) {
    bucket(t)[field] += n;
    schedulePersist();
  }

  // Raise this minute's concurrent-online high-water mark.
  function notePeak(online, t = now()) {
    const b = bucket(t);
    if (online > b[F_PEAK]) b[F_PEAK] = online;
  }

  // Distinct devices seen since `since` (and how many of them painted/watched).
  function visitorsSince(since) {
    let total = 0;
    let painters = 0;
    let watchers = 0;
    for (const v of visitors.values()) {
      if (v.s || v.l < since) continue;
      total += 1;
      if (v.p >= since) painters += 1;
      if (v.w >= since) watchers += 1;
    }
    return { visitors: total, painters, watchers };
  }

  // Event totals since `since` plus the window's peak online.
  function totalsSince(since, t = now()) {
    const out = { views: 0, arrivals: 0, joins: 0, strokes: 0, chats: 0, peak: 0 };
    const from = Math.floor(since / MINUTE_MS);
    const to = Math.floor(t / MINUTE_MS);
    for (const [m, b] of minutes) {
      if (m < from || m > to) continue;
      out.views += b[F_VIEWS];
      out.arrivals += b[F_ARRIVALS];
      out.joins += b[F_JOINS];
      out.strokes += b[F_STROKES];
      out.chats += b[F_CHATS];
      if (b[F_PEAK] > out.peak) out.peak = b[F_PEAK];
    }
    return out;
  }

  // The window re-binned into `bins` equal steps for a sparkline: each row is
  // [views, arrivals, joins, strokes, chats, peak] for that step.
  function series(since, bins, t = now()) {
    const span = Math.max(MINUTE_MS, t - since);
    const stepMs = Math.max(MINUTE_MS, Math.ceil(span / bins / MINUTE_MS) * MINUTE_MS);
    const n = Math.max(1, Math.ceil(span / stepMs));
    const start = t - n * stepMs;
    const rows = Array.from({ length: n }, () => new Array(FIELD_COUNT).fill(0));
    for (const [m, b] of minutes) {
      const ts = m * MINUTE_MS;
      if (ts < start || ts > t) continue;
      const i = Math.min(n - 1, Math.floor((ts - start) / stepMs));
      const row = rows[i];
      for (let f = 0; f < FIELD_COUNT; f += 1) {
        if (f === F_PEAK) row[f] = Math.max(row[f], b[f]);
        else row[f] += b[f];
      }
    }
    return { start, stepMs, rows };
  }

  // One window: counts + sparkline, clamped to what we retain.
  function window(since, bins = 48, t = now()) {
    const from = Math.max(since, t - RETAIN_MS);
    return {
      since: from,
      ...visitorsSince(from),
      ...totalsSince(from, t),
      series: series(from, bins, t),
    };
  }

  function stats() {
    return { visitors: visitors.size, minutes: minutes.size, retainMs: RETAIN_MS };
  }

  function reset() {
    visitors = new Map();
    minutes = new Map();
  }

  load();

  return {
    hash: hashVisitor,
    mark,
    markStaff,
    count,
    notePeak,
    visitorsSince,
    totalsSince,
    series,
    window,
    stats,
    prune,
    persistNow,
    reset,
  };
}
