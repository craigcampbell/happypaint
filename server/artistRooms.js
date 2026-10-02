// Artist public rooms, pure helpers for the audience 'artist_public'.
// Contract: docs/ARTIST-ROOMS-CONTRACT.md.
//
// An artist studio is publicly VIEWABLE (guests and strangers may watch) but
// never publicly editable: only the verified owner and explicitly approved
// painter accounts may draw. Everything here is pure data-shaping, no I/O,
// no room-map access, so server.js wires the same rules into load/persist,
// the WS guards, and the REST surface from one place.

export const ARTIST_AUDIENCE = 'artist_public';

// Bounds mirror the frontend fixtures (ArtistGalleryPage/ArtistRoomSettings):
// title 40 (the existing POST /api/rooms cap), description 280, <=8 tags of
// <=24 chars. The server REJECTS over-length input rather than truncating, so
// the owner sees honest feedback instead of a silently mangled listing.
export const ARTIST_LIMITS = { title: 40, description: 280, tags: 8, tagLength: 24 };

// An approved-painter list is bounded so a room file stays small even if an
// owner approves every request for months.
export const ARTIST_MAX_PAINTERS = 500;

export function isArtistRoom(room) {
  return !!room && room.audience === ARTIST_AUDIENCE;
}

export function defaultGallery() {
  return {
    listed: false,
    description: '',
    tags: [],
    publishedAt: null,
    event: null,
    moderationHidden: false,
  };
}

// One persisted gallery block read back from disk: every field re-validated,
// never trusted. Unknown keys are dropped (forward-compatible), bad types fall
// back to the safe default.
export function normalizeGallery(raw) {
  const base = defaultGallery();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  return {
    listed: raw.listed === true,
    description: typeof raw.description === 'string' ? raw.description.slice(0, ARTIST_LIMITS.description) : '',
    tags: sanitizeTags(raw.tags),
    publishedAt: typeof raw.publishedAt === 'string' && Number.isFinite(Date.parse(raw.publishedAt)) ? raw.publishedAt : null,
    event: typeof raw.event === 'string' && raw.event ? raw.event.slice(0, 40) : null,
    moderationHidden: raw.moderationHidden === true,
  };
}

// Approved painters are opaque verified account ids (PocketBase record ids) -
// never names or emails, so a leaked room file identifies nobody.
export function normalizePainters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry) continue;
    const id = entry.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= ARTIST_MAX_PAINTERS) break;
  }
  return out;
}

// Tags are plain lowercase display labels: letters/numbers/hyphens only,
// deduped, count- and length-capped. Invalid entries are DROPPED (not an
// error) so a stray comma never fails an otherwise good publish; the length
// caps themselves are enforced by validateArtistFields below.
export function sanitizeTags(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const tag = entry.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, ARTIST_LIMITS.tagLength);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= ARTIST_LIMITS.tags) break;
  }
  return out;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  // Plain text only: strip control characters (zero-width tricks, bidi
  // overrides) and collapse whitespace. What remains is safe to render and
  // safe to embed in a JSON API, the client renders it as text, not markup.
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Validate owner-supplied gallery text. `scan` is the shared moderation text
// filter (server/moderation/textFilter). Returns
//   { ok: true, title, description, tags }
// or { ok: false, error, message } with the error codes the frontend fixtures
// already map (bad_title / bad_description / bad_tags / moderation_rejected).
export function validateArtistFields(input, scan) {
  const body = input && typeof input === 'object' ? input : {};
  const title = cleanText(body.title);
  if (title.length > ARTIST_LIMITS.title) {
    return { ok: false, error: 'bad_title', message: `The title is too long, keep it to ${ARTIST_LIMITS.title} characters.` };
  }
  const description = cleanText(body.description);
  if (description.length > ARTIST_LIMITS.description) {
    return { ok: false, error: 'bad_description', message: `The description is too long, keep it to ${ARTIST_LIMITS.description} characters.` };
  }
  if (Array.isArray(body.tags) && body.tags.length > ARTIST_LIMITS.tags) {
    return { ok: false, error: 'bad_tags', message: `Too many tags, keep it to ${ARTIST_LIMITS.tags}.` };
  }
  const tags = sanitizeTags(body.tags);
  for (const [field, text] of [['title', title], ['description', description], ...tags.map((t) => ['tag', t])]) {
    if (!text) continue;
    const verdict = scan(text);
    if (verdict.hit) {
      return {
        ok: false,
        error: 'moderation_rejected',
        message: `That ${field} didn't pass the language check. Please reword it.`,
      };
    }
  }
  return { ok: true, title: title || null, description, tags };
}

// Who may draw in an artist studio: the verified owner and verified approved
// painters. Co-hosts are MODERATORS, hosting without approval does NOT grant
// painting. Anonymous users can never paint in an artist room.
export function canPaintIn(room, user) {
  if (!isArtistRoom(room)) return true; // other audiences: existing guards decide
  if (!user || !user.profileId || !user.verified) return false;
  if (user.profileId === room.ownerProfileId) return true;
  return Array.isArray(room.painters) && room.painters.includes(user.profileId);
}

// The roomProfile block riding the WS handshake + role_changed: gallery text
// and the SERVER-DERIVED event state (never a client-supplied day/prompt).
export function roomProfileFor(room, eventState = null) {
  if (!isArtistRoom(room)) return null;
  const gallery = room.gallery || defaultGallery();
  return {
    description: gallery.description || '',
    tags: Array.isArray(gallery.tags) ? gallery.tags : [],
    event: room.inktober ? eventState : null,
  };
}

// The message types a NON-painter in an artist room may send: read-only,
// social, and the access-request flow. Everything else, draw ops, clears,
// sheets, imports, layers, frames, scenes, animation structures, votes,
// helper setters, moderation, room management, is denied before the switch,
// so a patched client has no mutation bypass. Painters then pass through the
// existing host/layer/frame/lock guards like any room member.
export const ARTIST_VIEWER_ALLOWLIST = new Set([
  'ping', // keepalive
  'client_info', // device/timezone info (analytics)
  'chat', // social, artist-room chat is filtered like a public room
  'chat_react', // tapbacks
  'reaction', // emoji bursts
  'hype',
  'cheer',
  'beacon',
  'cursor', // pointer presence, no canvas effect
  'flag', // abuse reporting must stay open to viewers
  'watcher_ack', // moderation watcher election capability bit
  'paint_request', // the access-request flow itself
]);

// Room-MANAGEMENT powers an approved painter does NOT get. Approval grants
// drawing on the artist's canvas, nothing more: the room's wet/dry state,
// brush renderer, symmetry, theme votes, sheet/underlay, soundtrack and any
// story structure stay with the host (the verified owner and their co-host
// moderators). These are denied BEFORE the switch alongside the viewer
// allowlist, so a patched painter client has no management bypass, while
// ops, layers and frames keep flowing through the ordinary draw guards.
export const ARTIST_MANAGE_HOST_ONLY = new Set([
  'set_wet',
  'set_brush_mode',
  'set_symmetry',
  'vote_start',
  'set_sheet',
  'set_trace_photo',
  'set_soundtrack',
  'quest_reset',
  'storybook_caption',
  'storybook_lock',
  'storybook_move',
  'clear',
  'undo_clear',
  'wipe_request',
]);

// One sanitized gallery card: exactly the contracted keys, no account ids,
// no emails, no names, no location, safe to serve unauthenticated.
export function galleryCard(entry) {
  return {
    code: entry.code,
    title: typeof entry.title === 'string' && entry.title ? entry.title : null,
    description: typeof entry.description === 'string' ? entry.description : '',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    users: Number.isFinite(entry.users) ? entry.users : 0,
    ops: Number.isFinite(entry.ops) ? entry.ops : 0,
    event: typeof entry.event === 'string' && entry.event ? entry.event : null,
    canWatch: true,
  };
}

// Case-insensitive substring search over title + description + tags. Plain
// text in, plain text out, no regex from the query string.
export function galleryMatches(entry, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  const hay = [entry.title || '', entry.description || '', ...(entry.tags || [])]
    .join('\n')
    .toLowerCase();
  return needle.split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}
