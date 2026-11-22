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
const MAX_VERSION_BYTES = 1024 * 1024 * 1024;
const MAX_VERSIONS_PER_PAGE = 24;
const DAY = 86400000;
const PATTERN = /^(ai_[0-9a-f]{24})\.([a-f0-9]{64})\.([A-Z0-9_-]{1,16})\.(\d{13})\.([0-9a-f]{64}|none)\.[a-zA-Z0-9_-]{1,48}\.(?:entry|r([a-z0-9]{8,10}))$/;
const VERSION_PATTERN = /^(ai_[0-9a-f]{24})\.(v_[0-9a-f]{24})\.(\d{13})\.([a-f0-9]{64})\.png$/;
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

export function createAiColoringStore(dataDir) {
  const directory = join(dataDir, '.ai-coloring');
  let entries;
  let lastPruned = 0;
  let versionBytes = 0;
  const pending = new Map();

  function load() {
    if (entries) return entries;
    const records = new Map();
    if (existsSync(directory)) {
      const names = readdirSync(directory);
      for (const name of names) {
        if (name.endsWith('.tmp') && (PATTERN.test(name.slice(0, -4)) || VERSION_PATTERN.test(name.slice(0, -4)))) {
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
      let total = 0;
      for (const name of names) {
        const match = VERSION_PATTERN.exec(name);
        if (!match) continue;
        const [, pageId, id, createdAt, requestKey] = match;
        const entry = records.get(pageId);
        const path = join(directory, name);
        const { size, mtimeMs } = statSync(path);
        if (!hasPage(entry) || (!size && mtimeMs + DAY <= Date.now())) {
          // Finish an interrupted takedown before serving any archive reads.
          unlinkSync(path);
          continue;
        }
        (entry.versions ??= []).push({ id, createdAt: Number(createdAt), requestKey, size, path, deletedAt: size ? null : mtimeMs });
        total += size;
      }
      versionBytes = total;
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
    eraseVersions(record);
    try { unlinkSync(record.path); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    entries.delete(record.id);
  }

  function prune(now) {
    const due = now.getTime() - lastPruned >= 3600000;
    const keepSince = Math.min(monthStart(now), now.getTime() - DAY);
    let bytes = 0;
    for (const entry of load().values()) {
      // Delivered originals form the owner's coloring book. Only expired
      // usage markers are disposable. Keep takedowns for idempotent retries.
      if (due && entry.created < keepSince && entry.status !== 'removed' && !hasPage(entry)) remove(entry);
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
    // Closing a room cancels outstanding work. The account keeps its book.
    for (const [owner, entry] of pending) {
      if (entry.room === code) pending.delete(owner);
    }
  }

  function ownedPage(profile, id) {
    const entry = load().get(id);
    if (!hasPage(entry) || !profile || entry.owner !== hash(profile)) throw reject(404, 'page_not_found');
    return entry;
  }

  const versionMeta = ({ id, createdAt }) => ({ id, createdAt });

  function versionForKey(profile, id, key) {
    const entry = ownedPage(profile, id);
    const requestKey = hash(key);
    const version = entry.versions?.find(item => item.requestKey === requestKey);
    if (version && !version.size) throw reject(410, 'version_removed');
    return version ? versionMeta(version) : null;
  }

  function book(profile, offset, limit) {
    const owner = hash(profile);
    const rows = [...load().values()].filter(entry => hasPage(entry) && entry.owner === owner);
    rows.sort((a, b) => b.created - a.created || b.id.localeCompare(a.id));
    return {
      items: rows.slice(offset, offset + limit).map(entry => ({
        id: entry.id, title: TITLE, createdAt: entry.created,
        versions: (entry.versions || []).filter(item => item.size).map(versionMeta)
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)),
      })),
      total: rows.length,
    };
  }

  function ownedVersion(entry, id) {
    const version = entry.versions?.find(item => item.id === id);
    if (!version) throw reject(404, 'version_not_found');
    return version;
  }

  function removeVersion(entry, version) {
    try { unlinkSync(version.path); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    entry.versions.splice(entry.versions.indexOf(version), 1);
    versionBytes -= version.size;
  }

  function eraseVersions(entry) {
    for (const version of [...(entry.versions || [])]) removeVersion(entry, version);
  }

  function saveVersion(profile, pageId, key, png) {
    const entry = ownedPage(profile, pageId);
    const versions = entry.versions ??= [];
    const now = Date.now();
    for (const version of versions.filter(item => !item.size && item.deletedAt + DAY <= now)) removeVersion(entry, version);
    const requestKey = hash(key);
    const existing = versions.find(item => item.requestKey === requestKey);
    if (existing && !existing.size) throw reject(410, 'version_removed');
    if (existing) return versionMeta(existing);
    if (versions.filter(item => item.size).length >= MAX_VERSIONS_PER_PAGE) throw reject(409, 'version_limit');
    if (!Buffer.isBuffer(png) || png.length > MAX_PNG) throw reject(413, 'image_too_large');
    if (versionBytes + png.length > MAX_VERSION_BYTES) throw reject(503, 'storage_full');
    const id = 'v_' + randomBytes(12).toString('hex');
    const createdAt = now;
    const path = join(directory, [pageId, id, createdAt, requestKey, 'png'].join('.'));
    const version = { id, createdAt, requestKey, path };
    replaceContents(version, png);
    versions.push(version);
    versionBytes += version.size;
    return versionMeta(version);
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
    if (entry.status === status) {
      if (status === 'removed') eraseVersions(entry);
      return moderationRow(entry);
    }
    if (entry.status === 'removed') throw reject(409, 'page_removed');
    const reviewedAt = Date.now();
    if (status === 'reviewed') {
      const path = entry.path.replace(/\.entry$/, '.r' + reviewedAt.toString(36));
      renameSync(entry.path, path);
      entry.path = path;
    } else {
      // Commit the takedown with the deletion of the original. All version
      // reads require that original. Boot finishes an interrupted cleanup.
      replaceContents(entry, Buffer.from('removed:' + reviewedAt));
    }
    entry.status = status;
    entry.reviewedAt = reviewedAt;
    if (status === 'removed') eraseVersions(entry);
    return moderationRow(entry);
  }

  return {
    usage, latest, page, begin, finish, release, scrub, closeRoom, noteBlocked, listModeration, preview, moderate,
    book, saveVersion, versionForKey,
    bookImage(profile, id, versionId) {
      const entry = ownedPage(profile, id);
      if (!versionId) return readFileSync(entry.path);
      const version = ownedVersion(entry, versionId);
      if (!version.size) throw reject(404, 'version_not_found');
      return readFileSync(version.path);
    },
    deleteVersion(profile, id, versionId) {
      const version = ownedVersion(ownedPage(profile, id), versionId);
      if (!version.size) return;
      const size = version.size;
      // Retain only a request-key marker briefly so a delayed retry cannot
      // recreate a version the owner just erased.
      replaceContents(version, Buffer.alloc(0));
      version.deletedAt = Date.now();
      versionBytes -= size;
    },
    find(id) { const entry = load().get(id); return hasPage(entry) ? entry : null; },
    belongs(id, profile) {
      try { return Boolean(ownedPage(profile, id)); }
      catch { return false; } // An unreadable archive cannot authorize a wipe.
    },
  };
}
