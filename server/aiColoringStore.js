// A single atomic entry holds the private PNG or a short usage marker. Its
// filename carries the request metadata and optional human-review timestamp.
// Empty attempts and .entry PNGs from earlier versions remain readable.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 5;
const ATTEMPT_LIMIT = 12;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_PNG = 4 * 1024 * 1024;
const MAX_ENTRIES = 16384;
const DAY = 86400000;
const PATTERN = /^(ai_[0-9a-f]{24})\.([a-f0-9]{64})\.([A-Z0-9_-]{1,16})\.(\d{13})\.([0-9a-f]{64}|none)\.[a-zA-Z0-9_-]{1,48}\.(?:entry|r([a-z0-9]{8,10}))$/;
const TITLE = 'Custom coloring page';

const hash = value => createHash('sha256').update(value).digest('hex');
const monthStart = now => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
const reject = (status, code) => Object.assign(new Error(code), { status, code });
const hasPage = entry => entry?.status === 'pending' || entry?.status === 'reviewed';
const wasDelivered = entry => hasPage(entry) || entry.status === 'removed' || entry.status === 'closed';

function readStatus(path, size, reviewed) {
  if (size >= 24) return reviewed
    ? { status: 'reviewed', reviewedAt: parseInt(reviewed, 36) }
    : { status: 'pending' };
  if (!size) return { status: 'attempt' };
  const marker = readFileSync(path, 'utf8');
  if (marker === 'prompt' || marker === 'image') return { status: 'blocked', stage: marker };
  if (/^removed:\d{13}$/.test(marker)) return { status: 'removed', reviewedAt: Number(marker.slice(8)) };
  return { status: 'closed' }; // Includes the original one-byte room-deletion marker.
}

function moderationRow(entry) {
  return { id: entry.id, room: entry.room, createdAt: entry.created, status: entry.status, reviewedAt: entry.reviewedAt ?? null };
}

function replaceContents(entry, bytes) {
  const tmp = entry.path + '.tmp';
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, entry.path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* boot also sweeps incomplete writes */ }
    throw err;
  }
  entry.size = bytes.length;
}

export function createAiColoringStore(dataDir, isPinned) {
  const directory = join(dataDir, '.ai-coloring');
  let entries;
  let lastPruned = 0;
  const pending = new Map();

  function load() {
    if (entries) return entries;
    const records = new Map();
    if (existsSync(directory)) {
      for (const name of readdirSync(directory)) {
        if (name.endsWith('.tmp') && PATTERN.test(name.slice(0, -4))) {
          unlinkSync(join(directory, name)); // incomplete image from an interrupted write
          continue;
        }
        const match = PATTERN.exec(name);
        if (!match) continue;
        const [, id, owner, room, created, requestKey, reviewed] = match;
        const path = join(directory, name);
        const size = statSync(path).size;
        records.set(id, { id, owner, room, created: Number(created), requestKey, path, size, ...readStatus(path, size, reviewed) });
      }
    }
    entries = records;
    return entries;
  }

  function usage(profile, now = new Date()) {
    const owner = hash(profile);
    const start = monthStart(now);
    let attempts = 0;
    let pages = 0;
    for (const record of load().values()) {
      if (record.owner !== owner || record.created < start) continue;
      attempts++;
      if (wasDelivered(record)) pages++;
    }
    return { remaining: Math.max(0, LIMIT - pages), limit: LIMIT, attemptsRemaining: Math.max(0, ATTEMPT_LIMIT - attempts) };
  }

  function remove(record) {
    try { unlinkSync(record.path); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    entries.delete(record.id);
  }

  function prune(now) {
    const due = now.getTime() - lastPruned >= 3600000;
    const keepSince = Math.min(monthStart(now), now.getTime() - DAY);
    let bytes = 0;
    for (const entry of load().values()) {
      // Retain a takedown decision until room/account deletion. Even an old
      // idempotency key must never be sent back to the provider after removal.
      if (due && entry.created < keepSince && entry.status !== 'removed' && (!hasPage(entry) || !isPinned(entry.room, entry.id))) remove(entry);
      else bytes += entry.size;
    }
    if (due) lastPruned = now.getTime();
    return bytes;
  }

  function latest(profile, room) {
    const owner = hash(profile);
    let newest = null;
    for (const record of load().values()) {
      if (record.owner === owner && record.room === room && hasPage(record) && (!newest || record.created >= newest.created)) newest = record;
    }
    return newest;
  }

  function page(entry) {
    if (!hasPage(entry) || load().get(entry.id) !== entry) throw reject(404, 'page_not_found');
    return { id: entry.id, title: TITLE, image: 'data:image/png;base64,' + readFileSync(entry.path).toString('base64') };
  }

  function begin(profile, room, idempotencyKey, consentVersion) {
    const owner = hash(profile);
    const requestKey = idempotencyKey ? hash(idempotencyKey) : 'none';
    const records = load();
    if (idempotencyKey) {
      for (const entry of records.values()) {
        if (entry.owner !== owner || entry.room !== room || entry.requestKey !== requestKey) continue;
        if (entry.status === 'removed' || entry.status === 'closed') throw reject(410, 'page_removed');
        if (hasPage(entry)) return { existing: entry };
      }
    }
    if (pending.has(owner) || pending.size >= 4) throw reject(409, 'busy');
    const now = new Date();
    const budget = usage(profile, now);
    if (!budget.remaining) throw reject(429, 'monthly_limit');
    if (!budget.attemptsRemaining) throw reject(429, 'attempt_limit');
    const bytes = prune(now);
    if (bytes + (pending.size + 1) * MAX_PNG > MAX_BYTES || records.size >= MAX_ENTRIES) throw reject(503, 'storage_full');
    const id = 'ai_' + randomBytes(12).toString('hex');
    const created = now.getTime();
    const path = join(directory, [id, owner, room, created, requestKey, consentVersion, 'entry'].join('.'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    const entry = { id, owner, room, created, requestKey, path, size: 0, status: 'attempt' };
    records.set(id, entry);
    pending.set(owner, entry);
    return { entry };
  }

  function finish(entry, image) {
    if (pending.get(entry.owner) !== entry || !entries.has(entry.id) || entry.status !== 'attempt') throw reject(403, 'not_eligible');
    const prefix = 'data:image/png;base64,';
    if (typeof image !== 'string' || !image.startsWith(prefix) || image.length > prefix.length + 4 * Math.ceil(MAX_PNG / 3)) {
      throw reject(502, 'generation_failed');
    }
    const png = Buffer.from(image.slice(prefix.length), 'base64');
    if (png.length < 24 || png.length > MAX_PNG || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw reject(502, 'generation_failed');
    }
    replaceContents(entry, png);
    entry.status = 'pending';
    return { id: entry.id, title: TITLE, image };
  }

  function release(entry) {
    if (pending.get(entry.owner) === entry) pending.delete(entry.owner);
  }

  function scrub(profile) {
    const owner = hash(profile);
    pending.delete(owner); // a completing request can no longer recreate the page
    for (const entry of load().values()) {
      if (entry.owner === owner) remove(entry);
    }
  }

  function closeRoom(code) {
    for (const entry of load().values()) {
      if (entry.room !== code) continue;
      if (pending.get(entry.owner) === entry) pending.delete(entry.owner);
      if (entry.status === 'blocked') {
        replaceContents(entry, Buffer.alloc(0));
        entry.status = 'attempt';
        delete entry.stage;
      }
      if (!wasDelivered(entry) || entry.status === 'closed') continue;
      // Removing a room erases the private art immediately. A single byte
      // still counts the delivered page until the monthly budget rolls over.
      replaceContents(entry, Buffer.of(0));
      entry.status = 'closed';
    }
  }

  function noteBlocked(entry, stage) {
    if (!entry || entry.status !== 'attempt' || pending.get(entry.owner) !== entry ||
        (stage !== 'prompt' && stage !== 'image')) return;
    replaceContents(entry, Buffer.from(stage));
    entry.status = 'blocked';
    entry.stage = stage;
  }

  function listModeration({ status = 'pending', room = '', offset = 0, limit = 25 } = {}) {
    // Queue counts cover retained pages in this room (or all rooms).
    // Automatic blocks cover this UTC month and never expose rejected content.
    const counts = { pending: 0, reviewed: 0, removed: 0, blockedPrompt: 0, blockedImage: 0 };
    const start = monthStart(new Date());
    const rows = [];
    for (const entry of load().values()) {
      if (room && entry.room !== room) continue;
      if (entry.status === 'blocked' && entry.created >= start) {
        counts[entry.stage === 'prompt' ? 'blockedPrompt' : 'blockedImage']++;
      }
      if (!hasPage(entry) && entry.status !== 'removed') continue;
      counts[entry.status]++;
      if (status === 'all' || entry.status === status) rows.push(entry);
    }
    rows.sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
    return { items: rows.slice(offset, offset + limit).map(moderationRow), total: rows.length, counts };
  }

  function preview(id) {
    const entry = load().get(id);
    if (!hasPage(entry)) throw reject(404, 'page_not_found');
    return readFileSync(entry.path);
  }

  function moderate(id, status) {
    if (status !== 'reviewed' && status !== 'removed') throw reject(400, 'invalid_decision');
    const entry = load().get(id);
    if (!hasPage(entry) && entry?.status !== 'removed') throw reject(404, 'page_not_found');
    if (entry.status === status) return moderationRow(entry);
    if (entry.status === 'removed') throw reject(409, 'page_removed');
    const reviewedAt = Date.now();
    if (status === 'reviewed') {
      const path = entry.path.replace(/\.entry$/, '.r' + reviewedAt.toString(36));
      renameSync(entry.path, path);
      entry.path = path;
    } else {
      // This atomic replacement destroys the only PNG and commits its
      // takedown together. No second image or sidecar can survive a crash.
      replaceContents(entry, Buffer.from('removed:' + reviewedAt));
    }
    entry.status = status;
    entry.reviewedAt = reviewedAt;
    return moderationRow(entry);
  }

  return {
    usage, latest, page, begin, finish, release, scrub, closeRoom, noteBlocked, listModeration, preview, moderate,
    find(id) { const entry = load().get(id); return hasPage(entry) ? entry : null; },
    belongs(id, room, profile) {
      try {
        const entry = load().get(id);
        return Boolean(hasPage(entry) && entry.room === room && profile && entry.owner === hash(profile));
      } catch { return false; } // Unreadable private ink cannot block room entry or authorize a wipe.
    },
  };
}
