import express from 'express';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, fsyncSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const FEATURED_ROOM_LIMITS = Object.freeze({ items: 24, inputBytes: 3 * 1024 * 1024, imageBytes: 2 * 1024 * 1024, totalBytes: 24 * 1024 * 1024, titleLength: 80 });
const codePattern = /^[A-Z0-9_-]{1,16}$/;
const idPattern = /^[a-f0-9-]{36}$/;

/**
 * Contract: getRoomEligibility(code) is SYNCHRONOUS, authoritative, and does not
 * create a room. Return null for missing/deleted rooms, otherwise explicit:
 * {exists:true, audience:'kid_safe'|'artist_public', listed:true, hidden:false,
 *  sketchbook:false, published:true (required for artist_public), version:string}.
 * `version` identifies the room incarnation + moderation/permission generation;
 * it must change when art is hidden/removed or room is deleted/recreated. It must
 * NOT change for ordinary new strokes. Never derive eligibility from client data.
 * Every public listing/image read checks this adapter; exceptions fail closed.
 * registerRoutes(app, adminGuard): guard follows server's boolean (req,res) API.
 */
export function createFeaturedRooms({ dataDir, getRoomEligibility, limits = {} }) {
  if (!dataDir || typeof getRoomEligibility !== 'function') throw new Error('Featured rooms require dataDir and authoritative getRoomEligibility');
  const cap = { ...FEATURED_ROOM_LIMITS, ...limits };
  const dir = join(dataDir, '.featured-rooms');
  const file = join(dir, 'index.json');
  mkdirSync(dir, { recursive: true });
  let items = [];
  let writable = true;
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored.schema !== 1 || !Array.isArray(stored.items) || stored.items.length > cap.items || !stored.items.every((item) => idPattern.test(item.id) && codePattern.test(item.roomCode) && typeof item.version === 'string' && typeof item.title === 'string' && item.title.length <= cap.titleLength && Number.isFinite(Date.parse(item.capturedAt)) && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= cap.imageBytes) || stored.items.reduce((n, item) => n + item.bytes, 0) > cap.totalBytes) throw new Error('Invalid featured store');
    items = stored.items;
  } catch (error) {
    if (error.code !== 'ENOENT') { writable = false; console.error('[featured-rooms] Invalid store; publication disabled'); }
  }
  // Interrupted writes can leave unreferenced raster files. Never accumulate
  // unbounded disk use across failed writes/restarts; no public static mount.
  if (writable) for (const name of readdirSync(dir)) {
    if ((/^[a-f0-9-]{36}\.webp$/.test(name) && !items.some((item) => `${item.id}.webp` === name)) || name.endsWith('.tmp')) {
      try { unlinkSync(join(dir, name)); } catch { /* retry on next boot */ }
    }
  }
  function source(code) {
    try {
      const room = getRoomEligibility(code);
      if (room?.exists !== true || room.listed !== true || room.hidden !== false || room.sketchbook !== false || !['kid_safe', 'artist_public'].includes(room.audience) || (room.audience === 'artist_public' && room.published !== true) || typeof room.version !== 'string' || !room.version.length || room.version.length > 512) return null;
      return room;
    } catch { return null; }
  }
  const visible = (item) => source(item.roomCode)?.version === item.version;
  const publicItem = (item) => ({ id: item.id, roomCode: item.roomCode, title: item.title, capturedAt: item.capturedAt, imageUrl: `/api/featured-rooms/${item.id}/image` });
  function atomicWrite(path, data) {
    const temp = `${path}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, data); fsyncSync(fd); closeSync(fd); fd = undefined; renameSync(temp, path);
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* renamed */ } }
  }
  function persist(next) {
    if (!writable) throw new Error('Invalid store');
    atomicWrite(file, JSON.stringify({ schema: 1, items: next }));
    items = next;
  }
  function registerRoutes(app, adminGuard) {
    if (typeof adminGuard !== 'function') throw new Error('Admin guard required');
    app.use(['/api/featured-rooms', '/api/admin/featured-rooms'], (_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
    app.get('/api/featured-rooms', (_req, res) => res.json({ items: items.filter(visible).map(publicItem) }));
    app.get('/api/featured-rooms/:id/image', (req, res) => {
      const item = items.find((entry) => entry.id === req.params.id);
      if (!item || !visible(item)) return res.status(404).json({ error: 'not_found' });
      try {
        const bytes = readFileSync(join(dir, `${item.id}.webp`));
        return res.type('image/webp').send(bytes);
      } catch { return res.status(404).json({ error: 'not_found' }); }
    });
    app.use('/api/admin/featured-rooms', (req, res, next) => { if (adminGuard(req, res)) next(); });
    app.get('/api/admin/featured-rooms', (_req, res) => res.json({ items: items.map((item) => ({ ...publicItem(item), available: visible(item) })), limits: cap }));
    app.get('/api/admin/featured-rooms/source/:code', (req, res) => {
      const room = codePattern.test(req.params.code) ? source(req.params.code) : null;
      if (!room) return res.status(403).json({ error: 'room_not_eligible' });
      return res.json({ roomCode: req.params.code, version: room.version });
    });
    app.post('/api/admin/featured-rooms', express.json({ limit: '4200kb' }), async (req, res) => {
      const body = req.body;
      if (!body || typeof body.version !== 'string' || !body.version.length || body.version.length > 512 || typeof body.roomCode !== 'string' || !codePattern.test(body.roomCode) || typeof body.title !== 'string' || body.title.length > cap.titleLength || [...body.title].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || body.confirmed !== true || typeof body.image !== 'string' || Object.keys(body).some((key) => !['roomCode', 'title', 'image', 'confirmed', 'version'].includes(key))) return res.status(400).json({ error: 'invalid_request' });
      const initial = source(body.roomCode);
      if (!initial) return res.status(403).json({ error: 'room_not_eligible' });
      if (body.version !== undefined && body.version !== initial.version) return res.status(409).json({ error: 'source_changed' });
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(body.image);
      if (!match) return res.status(400).json({ error: 'raster_required' });
      if (match[2].length > Math.ceil(cap.inputBytes / 3) * 4) return res.status(413).json({ error: 'image_too_large' });
      let bytes;
      try {
        const input = Buffer.from(match[2], 'base64');
        if (input.length > cap.inputBytes || input.toString('base64') !== match[2]) return res.status(400).json({ error: 'invalid_image' });
        const metadata = await sharp(input, { limitInputPixels: 16000000 }).metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1 || metadata.format !== match[1]) return res.status(400).json({ error: 'raster_required' });
        bytes = await sharp(input, { limitInputPixels: 16000000 }).rotate().resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).webp({ quality: 88 }).toBuffer();
      } catch { return res.status(400).json({ error: 'invalid_image' }); }
      if (bytes.length > cap.imageBytes) return res.status(413).json({ error: 'image_too_large' });
      // Recheck after asynchronous decoding, then synchronous persist is the
      // commit boundary. Concurrent requests cannot race the count/byte caps.
      if (source(body.roomCode)?.version !== initial.version) return res.status(409).json({ error: 'source_changed' });
      if (items.length >= cap.items || items.reduce((n, item) => n + item.bytes, 0) + bytes.length > cap.totalBytes) return res.status(409).json({ error: 'collection_full' });
      const item = { id: randomUUID(), roomCode: body.roomCode, title: body.title.trim(), version: initial.version, capturedAt: new Date().toISOString(), bytes: bytes.length, sourceProfiles: Array.isArray(initial.profileIds) ? [...new Set(initial.profileIds.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 256))] : null };
      const raster = join(dir, `${item.id}.webp`);
      try { atomicWrite(raster, bytes); persist([item, ...items]); }
      catch { try { unlinkSync(raster); } catch { /* no partial file */ } return res.status(503).json({ error: 'persistence_failed' }); }
      return res.status(201).json({ item: publicItem(item) });
    });
    app.delete('/api/admin/featured-rooms/:id', (req, res) => {
      const item = items.find((entry) => entry.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'not_found' });
      try { persist(items.filter((entry) => entry !== item)); }
      catch { return res.status(503).json({ error: 'persistence_failed' }); }
      try { unlinkSync(join(dir, `${item.id}.webp`)); } catch { /* orphan cleanup at boot */ }
      return res.json({ removed: item.id });
    });
    app.use('/api/admin/featured-rooms', (error, _req, res, next) => {
      if (error.type === 'entity.too.large') return res.status(413).json({ error: 'body_too_large' });
      if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
      next(error);
    });
  }
  // Used at source withdrawal/deletion and account erasure. Metadata is
  // committed before bytes are unlinked, so no route can serve a removed row.
  function scrubSources(predicate) {
    const removed = items.filter((item) => predicate(item.roomCode));
    if (!removed.length) return 0;
    persist(items.filter((item) => !removed.includes(item)));
    for (const item of removed) {
      try { unlinkSync(join(dir, `${item.id}.webp`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return removed.length;
  }
  function scrubProfile(profileId, relatedRooms = new Set()) {
    const selected = new Set(items.filter((item) => !Array.isArray(item.sourceProfiles)
      || item.sourceProfiles.includes(profileId) || relatedRooms.has(item.roomCode)).map((item) => item.roomCode));
    return scrubSources((code) => selected.has(code));
  }
  return { registerRoutes, scrubSources, scrubProfile };
}
