// A single atomic entry is both the usage record and the private PNG. An empty
// entry is an attempted generation. A process restart cannot reset the budget
// or charge a page that never finished. Filenames contain no prompt text.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LIMIT = 5;
const ATTEMPT_LIMIT = 12;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_PNG = 4 * 1024 * 1024;
const MAX_ENTRIES = 16384;
const DAY = 86400000;
const PATTERN = /^(ai_[0-9a-f]{24})\.([a-f0-9]{64})\.([A-Z0-9_-]{1,16})\.(\d{13})\.([0-9a-f]{64}|none)\.[a-zA-Z0-9_-]{1,48}\.entry$/;
const TITLE = 'Custom coloring page';

const hash = value => createHash('sha256').update(value).digest('hex');
const monthStart = now => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
const reject = (status, code) => Object.assign(new Error(code), { status, code });

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
        if (name.endsWith('.entry.tmp') && PATTERN.test(name.slice(0, -4))) {
          unlinkSync(join(directory, name)); // incomplete image from an interrupted write
          continue;
        }
        const match = PATTERN.exec(name);
        if (!match) continue;
        const [, id, owner, room, created, requestKey] = match;
        const path = join(directory, name);
        records.set(id, { id, owner, room, created: Number(created), requestKey, path, size: statSync(path).size });
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
      if (record.size) pages++;
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
      if (due && entry.created < keepSince && (entry.size <= 1 || !isPinned(entry.room, entry.id))) remove(entry);
      else bytes += entry.size;
    }
    if (due) lastPruned = now.getTime();
    return bytes;
  }

  function latest(profile, room) {
    const owner = hash(profile);
    let newest = null;
    for (const record of load().values()) {
      if (record.owner === owner && record.room === room && record.size > 1 && (!newest || record.created >= newest.created)) newest = record;
    }
    return newest;
  }

  function page(entry) {
    return { id: entry.id, title: TITLE, image: 'data:image/png;base64,' + readFileSync(entry.path).toString('base64') };
  }

  function begin(profile, room, idempotencyKey, consentVersion) {
    const owner = hash(profile);
    const requestKey = idempotencyKey ? hash(idempotencyKey) : 'none';
    const records = load();
    if (idempotencyKey) {
      for (const entry of records.values()) {
        if (entry.owner === owner && entry.room === room && entry.requestKey === requestKey && entry.size > 1) {
          return { existing: entry };
        }
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
    const entry = { id, owner, room, created, requestKey, path, size: 0 };
    records.set(id, entry);
    pending.set(owner, entry);
    return { entry };
  }

  function finish(entry, image) {
    if (pending.get(entry.owner) !== entry || !entries.has(entry.id)) throw reject(403, 'not_eligible');
    const prefix = 'data:image/png;base64,';
    if (typeof image !== 'string' || !image.startsWith(prefix) || image.length > prefix.length + 4 * Math.ceil(MAX_PNG / 3)) {
      throw reject(502, 'generation_failed');
    }
    const png = Buffer.from(image.slice(prefix.length), 'base64');
    if (png.length < 24 || png.length > MAX_PNG || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
      throw reject(502, 'generation_failed');
    }
    const tmp = entry.path + '.tmp';
    try {
      writeFileSync(tmp, png, { mode: 0o600 });
      renameSync(tmp, entry.path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* next boot also sweeps partial writes */ }
      throw err;
    }
    entry.size = png.length;
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
      if (entry.room !== code || entry.size <= 1) continue;
      // Removing a room erases the private art immediately. A single byte
      // still counts the delivered page until the monthly budget rolls over.
      writeFileSync(entry.path + '.tmp', Buffer.of(0), { mode: 0o600 });
      renameSync(entry.path + '.tmp', entry.path);
      entry.size = 1;
    }
  }

  return {
    usage, latest, page, begin, finish, release, scrub, closeRoom,
    find(id) { const entry = load().get(id); return entry?.size > 1 ? entry : null; },
    belongs(id, room, profile) {
      try {
        const entry = load().get(id);
        return Boolean(entry && entry.size > 1 && entry.room === room && profile && entry.owner === hash(profile));
      } catch { return false; } // Unreadable private ink cannot block room entry or authorize a wipe.
    },
  };
}
