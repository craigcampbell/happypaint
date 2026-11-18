import { randomInt } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTACT_RE, CONCERN_RE } from './moderation/console.js';
import { scan } from './moderation/textFilter.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FRIEND_CODE = /^[A-HJ-NP-Z2-9]{12}$/;
const MAX_CONTACTS = 64;
const MAX_PENDING = 32;
const QUIET_MS = 30 * 24 * 60 * 60_000;

class FriendError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function nickname(input) {
  const name = typeof input === 'string' ? input.normalize('NFKC').trim() : '';
  if (!name || [...name].length > 24 || !/^[\p{L}\p{N}\p{M} _'’-]+$/u.test(name)
      || !/[\p{L}\p{N}]/u.test(name) || scan(name).hit || CONTACT_RE.test(name) || CONCERN_RE.test(name)) {
    throw new FriendError(400, 'invalid_name');
  }
  return name;
}

function contactCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!FRIEND_CODE.test(code)) throw new FriendError(400, 'invalid_code');
  return code;
}

function countLinks(profile, kind) {
  return Object.values(profile.links).filter((link) => link.kind === kind).length;
}

// An optional account directory. Both ends of a relationship are committed by
// one rename in the single app process. GET never enrolls an account. Names and
// codes appear only on the two participants' authenticated lists.
export function createFriends(dataDir) {
  const file = join(dataDir, '.friends.json');
  let profiles;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.profiles)) throw new Error('Invalid friend directory');
    profiles = new Map(data.profiles);
  } catch (err) {
    if (err.code === 'ENOENT') profiles = new Map();
    else console.error('Friends directory could not be loaded');
  }
  const byCode = new Map();
  const byRoom = new Map();
  function index() {
    byCode.clear();
    byRoom.clear();
    for (const [id, profile] of profiles) {
      byCode.set(profile.code, id);
      for (const link of Object.values(profile.links)) {
        if (link.kind !== 'friend') continue;
        if (!byRoom.has(link.roomCode)) byRoom.set(link.roomCode, new Set());
        byRoom.get(link.roomCode).add(id);
      }
    }
  }
  if (profiles) {
    try { index(); } catch { profiles = null; console.error('Friends directory could not be indexed'); }
  }
  function ready() { if (!profiles) throw new Error('Friends directory unavailable'); }
  function save(next) {
    const tmp = `${file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, profiles: [...next] }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* No temporary file. */ }
      throw err;
    }
    profiles = next;
    index();
  }
  function view(id, isBlocked) {
    ready();
    const me = profiles.get(id);
    const state = { self: me ? { code: me.code, name: me.name } : null, incoming: [], outgoing: [], friends: [] };
    for (const [code, link] of Object.entries(me?.links || {})) {
      if (link.kind === 'quiet') continue;
      const targetId = byCode.get(code);
      const person = profiles.get(targetId);
      if (!person || isBlocked(targetId)) continue;
      const item = { code, name: person.name };
      if (link.kind === 'friend') state.friends.push({ ...item, roomCode: link.roomCode });
      else state[link.kind].push(item);
    }
    return state;
  }
  function profile(id, value) {
    ready();
    const name = nickname(value);
    const old = profiles.get(id);
    if (old?.name === name) return;
    let code = old?.code;
    if (!code) {
      do { code = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); }
      while (byCode.has(code));
    }
    save(new Map(profiles).set(id, { code, name, links: old?.links || {} }));
  }
  function contact(id, value, action, { mintRoom, isBlocked }) {
    ready();
    const me = profiles.get(id);
    if (!me) throw new FriendError(409, 'profile_required');
    const code = contactCode(value);
    if (code === me.code) throw new FriendError(400, 'self_request');
    const otherId = byCode.get(code);
    const other = profiles.get(otherId);
    if (action === 'remove' && (!other || !me.links[code] || me.links[code].kind === 'quiet')) return;
    if (!other || (action !== 'remove' && isBlocked(otherId))) throw new FriendError(404, 'contact_unavailable');
    const link = me.links[code];
    const mine = { ...me.links };
    const theirs = { ...other.links };
    if (action === 'request') {
      if (link?.kind === 'friend' || link?.kind === 'outgoing') return;
      if (link?.kind === 'incoming') throw new FriendError(409, 'incoming_request');
      if (theirs[me.code]?.kind === 'quiet' && theirs[me.code].until > Date.now()) throw new FriendError(404, 'contact_unavailable');
      if (countLinks(me, 'outgoing') >= MAX_PENDING || countLinks(other, 'incoming') >= MAX_PENDING
          || countLinks(me, 'friend') >= MAX_CONTACTS || countLinks(other, 'friend') >= MAX_CONTACTS) throw new FriendError(429, 'contact_limit');
      mine[code] = { kind: 'outgoing' };
      theirs[me.code] = { kind: 'incoming' };
    } else if (action === 'accept') {
      if (link?.kind === 'friend') return;
      if (link?.kind !== 'incoming') throw new FriendError(409, 'no_incoming_request');
      if (countLinks(me, 'friend') >= MAX_CONTACTS || countLinks(other, 'friend') >= MAX_CONTACTS) throw new FriendError(429, 'contact_limit');
      const accepted = { kind: 'friend', roomCode: mintRoom() };
      mine[code] = accepted;
      theirs[me.code] = accepted;
    } else {
      delete mine[code];
      delete theirs[me.code];
      // Declining/removing stops new requests from that contact. Cancelling an
      // outgoing request cannot be used for repeated notifications either. The
      // recipient can still explicitly start a new invitation in reverse.
      const cancelled = link.kind === 'outgoing';
      const quiet = cancelled ? theirs : mine;
      const now = Date.now();
      for (const [key, item] of Object.entries(quiet)) if (item.kind === 'quiet' && item.until <= now) delete quiet[key];
      const retained = Object.entries(quiet).filter(([, item]) => item.kind === 'quiet');
      if (retained.length >= 256) delete quiet[retained[0][0]];
      quiet[cancelled ? me.code : code] = { kind: 'quiet', until: now + QUIET_MS };
    }
    save(new Map(profiles).set(id, { ...me, links: mine }).set(otherId, { ...other, links: theirs }));
  }
  function scrub(id) {
    ready();
    const me = profiles.get(id);
    if (!me) return;
    const next = new Map(profiles);
    next.delete(id);
    for (const [otherId, row] of next) {
      if (!Object.hasOwn(row.links, me.code)) continue;
      const links = { ...row.links };
      delete links[me.code];
      next.set(otherId, { ...row, links });
    }
    save(next);
  }
  return { view, profile, contact, scrub,
    reserved: (code) => code.length === 8 && (!profiles || byRoom.has(code)),
    member: (code, id) => Boolean(profiles && byRoom.get(code)?.has(id)),
    memberName: (code, id) => profiles && byRoom.get(code)?.has(id) ? profiles.get(id)?.name : null,
  };
}

export function registerFriends(app, { store, configured, identity, ip, isBlocked, rateOk, mintRoom }) {
  app.use('/api/friends', async (req, res, next) => {
    res.set('Cache-Control', 'private, no-store').vary('Authorization');
    if (!configured) return res.status(503).json({ error: 'accounts_unconfigured' });
    const address = ip(req);
    if (!rateOk(`friends-ip:${address}`, 180, 60_000)) return res.status(429).json({ error: 'rate_limited' });
    const who = await identity(req);
    if (!who) return res.status(401).json({ error: 'signin_required' });
    if (isBlocked(who.profileId, address)) return res.status(403).json({ error: 'blocked' });
    if (req.method !== 'GET' && !rateOk(`friends-write:${who.profileId}`, 30, 60_000)) return res.status(429).json({ error: 'rate_limited' });
    res.locals.friendId = who.profileId;
    next();
  });
  function handle(action) {
    return (req, res) => {
      const id = res.locals.friendId;
      try {
        if (action === 'profile') store.profile(id, req.body?.name);
        else if (action) store.contact(id, req.params.code || req.body?.code, action, { mintRoom, isBlocked });
        res.json(store.view(id, isBlocked));
      } catch (err) {
        if (err instanceof FriendError) return res.status(err.status).json({ error: err.message });
        res.status(503).json({ error: 'friends_unavailable' });
      }
    };
  }
  app.get('/api/friends', handle());
  app.post('/api/friends/profile', handle('profile'));
  app.post('/api/friends/request', handle('request'));
  app.post('/api/friends/accept', handle('accept'));
  app.delete('/api/friends/contact/:code', handle('remove'));
}
