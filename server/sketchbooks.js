// Inktober artist sketchbooks — pure helpers for multi-page event books.
// Contract: docs/SKETCHBOOKS-CONTRACT.md.
//
// A sketchbook (BOOK) groups up to 31 daily-prompt pages for one event
// ('inktober-2026'). Every page is a DISTINCT, ordinary artist_public room
// (room.sketchbook points back at the book) so the frozen brush/frame replay
// stack is reused untouched. The book owns the cross-page rules:
//   - one book per owner account + event (create resumes idempotently)
//   - up to 31 pages, one per official prompt day (server-validated list)
//   - the page's day/prompt/date are stamped SERVER-side at page creation
//     from the verified prompt list and are immutable afterwards
//   - the owner plus at most 5 invitees (6 distinct artist ACCOUNTS total,
//     never sockets) may draw across every page
//   - invitation is by scoped, revocable token; only the SHA-256 hash is
//     persisted, and the token never appears in any list/public response
//   - books are PUBLIC BY EXPLICIT CREATION OPT-IN only (public === true
//     must be affirmed in the create call); pre-existing private art is
//     never touched by anything here
//   - a book can also be UNSAVED (guest): started by a visitor who has no
//     account, public from the first stroke, drawn only by the device that
//     started it, and handed to an account later by
//     POST /api/sketchbooks/claim ('guest' below).
//
// Everything in this file is pure data-shaping — no I/O, no room-map access —
// so server.js wires the same rules into REST/WS/persistence from one place.

import { createHash, randomBytes } from 'crypto';

export const SKETCHBOOK_EVENT = 'inktober-2026';
export const SKETCHBOOK_MAX_PAGES = 31;
export const SKETCHBOOK_MAX_ARTISTS = 6; // owner + 5 invitees, distinct accounts
export const SKETCHBOOK_MAX_ACTIVE_INVITES = 20;
export const SKETCHBOOK_TITLE_MAX = 40;
// An UNSAVED (guest) book that never got any artwork is reaped after this long.
// A visitor who taps a prompt and never draws must not leave a record behind
// forever. A guest book WITH artwork is never reaped: artwork is never
// destroyed, it simply stays public and unsaved until the device saves it.
export const SKETCHBOOK_GUEST_MAX_EMPTY_MS = 14 * 24 * 3600_000;

// ---- ids / tokens ------------------------------------------------------------

export function mintBookId() {
  return `sb_${randomBytes(8).toString('hex')}`; // 16 hex chars, unguessable enough with owner ACLs
}

export function mintInviteToken() {
  return `sbk_${randomBytes(24).toString('base64url')}`; // shown to the inviter ONCE
}

// Only the digest ever touches disk or memory-long-lived structures.
export function hashInviteToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

// The SAVE token of an UNSAVED (guest) book: the one secret that proves the
// account signing in is the device that drew the pages. Shown to that device
// ONCE and stored hashed, exactly like an invite token.
export function mintClaimToken() {
  return `sbkc_${randomBytes(24).toString('base64url')}`;
}

export function hashClaimToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

// ---- normalization -------------------------------------------------------------

function cleanId(value, max = 40) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, max);
}

// The back-reference stamped on every page room (persisted in the room file):
// the book id plus the IMMUTABLE server-stamped prompt metadata for that page.
export function normalizeSketchbookRef(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const book = cleanId(raw.book, 24);
  const day = Number(raw.day);
  if (!book || !/^sb_[0-9a-f]{16}$/.test(book)) return null;
  if (!Number.isInteger(day) || day < 1 || day > SKETCHBOOK_MAX_PAGES) return null;
  return {
    book,
    day,
    prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, 80) : '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? String(raw.date) : '',
  };
}

function normalizePage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const room = String(raw.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const day = Number(raw.day);
  if (!room || !Number.isInteger(day) || day < 1 || day > SKETCHBOOK_MAX_PAGES) return null;
  return {
    room,
    day,
    prompt: typeof raw.prompt === 'string' ? raw.prompt.slice(0, 80) : '',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? String(raw.date) : '',
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString(),
  };
}

function normalizeInvite(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanId(raw.id, 24);
  const hash = String(raw.hash || '').replace(/[^0-9a-f]/g, '').slice(0, 64);
  if (!id || hash.length !== 64) return null;
  return {
    id,
    hash,
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString(),
    revokedAt: Number.isFinite(Date.parse(raw.revokedAt)) ? raw.revokedAt : null,
    uses: Number.isInteger(raw.uses) && raw.uses >= 0 ? Math.min(raw.uses, 100000) : 0,
  };
}

// The UNSAVED (guest) binding of a book: which DEVICE started it, and the
// digest of the save token that hands it to an account later. Both are re-read
// from disk defensively, like every other field.
function normalizeGuest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const device = String(raw.device || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const claimHash = String(raw.claimHash || '').replace(/[^0-9a-f]/g, '').slice(0, 64);
  if (!device || claimHash.length !== 64) return null;
  return {
    device,
    claimHash,
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString(),
  };
}

// One persisted book read back from disk: every field re-validated, never
// trusted. Unknown keys are dropped; bad types fall back to safe defaults.
export function normalizeBook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '');
  if (!/^sb_[0-9a-f]{16}$/.test(id)) return null;
  // A book is either account-owned or an UNSAVED guest book (no account yet).
  const guest = normalizeGuest(raw.guest);
  const ownerProfileId = cleanId(raw.ownerProfileId) || null;
  if (!guest && !ownerProfileId) return null;
  const artists = [];
  const seen = new Set();
  // The owner always counts as artist #1; invitees follow, deduped, capped.
  // A guest book has NO artists: until it is saved, only the device that
  // started it may draw, and that is enforced per connection, not by an ACL.
  for (const entry of guest ? [] : [ownerProfileId, ...(Array.isArray(raw.artists) ? raw.artists : [])]) {
    const pid = cleanId(entry);
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    artists.push(pid);
    if (artists.length >= SKETCHBOOK_MAX_ARTISTS) break;
  }
  const pages = [];
  const days = new Set();
  for (const entry of Array.isArray(raw.pages) ? raw.pages : []) {
    const page = normalizePage(entry);
    if (!page || days.has(page.day)) continue;
    days.add(page.day);
    pages.push(page);
    if (pages.length >= SKETCHBOOK_MAX_PAGES) break;
  }
  pages.sort((a, b) => a.day - b.day);
  const invites = [];
  for (const entry of Array.isArray(raw.invites) ? raw.invites : []) {
    const invite = normalizeInvite(entry);
    if (invite) invites.push(invite);
    if (invites.length >= 200) break; // dead invites are kept for audit but bounded
  }
  return {
    id,
    event: typeof raw.event === 'string' && raw.event ? raw.event.slice(0, 40) : SKETCHBOOK_EVENT,
    ownerProfileId,
    title: typeof raw.title === 'string' && raw.title ? raw.title.slice(0, SKETCHBOOK_TITLE_MAX) : null,
    // Public visibility is an explicit, persisted opt-in — never defaulted on.
    // An UNSAVED guest book is public by definition (that is how it is found on
    // the Inktober page) and carries no invites: there is no account to invite.
    public: guest ? true : raw.public === true,
    moderationHidden: raw.moderationHidden === true,
    // The guest binding (null once the book has been saved by an account).
    guest,
    artists,
    pages,
    invites: guest ? [] : invites,
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : new Date(0).toISOString(),
  };
}

// ---- unsaved (guest) books ---------------------------------------------------

// True for a book that has no account owner yet: public, drawable by the one
// device that started it, and saved by POST /api/sketchbooks/claim.
export function isGuestBook(book) {
  return !!(book && book.guest && book.guest.device);
}

// Does this connection's device own the unsaved book? The device key is the
// same per-browser id the client already sends for its anonymous gallery and
// in the WS auth frame, so no new secret and no new handshake field.
export function guestOwnsBook(book, deviceKey) {
  return !!(isGuestBook(book) && deviceKey && book.guest.device === String(deviceKey));
}

// Which account (if any) may adopt the book with this save token.
export function guestBookMatchesClaim(book, claimHash) {
  return !!(isGuestBook(book) && claimHash && book.guest.claimHash === claimHash);
}

// ---- day / prompt validation ---------------------------------------------------

// `prompts` is the SERVER's verified official list (inktoberState().prompts) —
// never a client payload. Returns the canonical {day, prompt, date} or null.
export function promptForDay(prompts, day) {
  const d = Number(day);
  if (!Number.isInteger(d) || d < 1 || d > SKETCHBOOK_MAX_PAGES) return null;
  const entry = (Array.isArray(prompts) ? prompts : []).find((p) => Number(p.day) === d);
  if (!entry || typeof entry.prompt !== 'string' || !entry.prompt) return null;
  return { day: d, prompt: String(entry.prompt).slice(0, 80), date: String(entry.date || '') };
}

// ---- capability checks -----------------------------------------------------------

export function isBookOwner(book, profileId) {
  return !!book && !!profileId && book.ownerProfileId === String(profileId);
}

export function isBookArtist(book, profileId) {
  return !!book && !!profileId && book.artists.includes(String(profileId));
}

export function bookHasCapacity(book) {
  return !!book && book.artists.length < SKETCHBOOK_MAX_ARTISTS;
}

// ---- response shaping --------------------------------------------------------------

// The PUBLIC book view: no account ids, no invite details, no token material.
// `pageInfo` maps room code -> { ops, watching, hidden } resolved by server.js
// from live rooms + persisted metas; moderation-hidden pages are OMITTED for
// everyone but the owner (who sees them flagged, so hidden work isn't
// silently lost to them).
export function bookPublicView(book, pageInfo = {}, { owner = false } = {}) {
  const pages = [];
  for (const page of book.pages) {
    const info = pageInfo[page.room] || {};
    const hidden = info.hidden === true;
    if (hidden && !owner) continue;
    pages.push({
      room: page.room,
      day: page.day,
      prompt: page.prompt,
      date: page.date,
      ops: Number.isFinite(info.ops) ? info.ops : 0,
      watching: Number.isFinite(info.watching) ? info.watching : 0,
      hidden,
      canWatch: true,
    });
  }
  const view = {
    id: book.id,
    event: book.event,
    title: book.title,
    public: book.public === true,
    // UNSAVED: no account owns this book yet. The reader shows the visitor an
    // honest "not saved yet" notice instead of owner controls.
    unsaved: isGuestBook(book),
    artistCount: book.artists.length,
    maxArtists: SKETCHBOOK_MAX_ARTISTS,
    pageCount: book.pages.length,
    maxPages: SKETCHBOOK_MAX_PAGES,
    pages,
    createdAt: book.createdAt,
    canWatch: true,
  };
  if (owner && !isGuestBook(book)) {
    // Opaque account ids ONLY to the owner (same rule as the room ACL API).
    view.owner = true;
    view.artists = [...book.artists];
    view.moderationHidden = book.moderationHidden === true;
    view.invites = book.invites.map((inv) => ({
      id: inv.id,
      createdAt: inv.createdAt,
      revokedAt: inv.revokedAt,
      uses: inv.uses,
      // NEVER the token or even the full hash.
    }));
  }
  return view;
}

// Gallery eligibility: explicit public opt-in, not moderation-hidden, and at
// least one visible page with REAL drawing (ops > 0) — an empty book is not
// "new Inktober artwork" and never auto-lists.
export function bookGalleryEligible(book, pageInfo = {}) {
  if (!book || book.public !== true || book.moderationHidden === true) return false;
  return book.pages.some((page) => {
    const info = pageInfo[page.room] || {};
    return info.hidden !== true && Number.isFinite(info.ops) && info.ops > 0;
  });
}

// One sanitized gallery card: no account ids, no names, no emails.
export function bookGalleryCard(book, pageInfo = {}) {
  const drawn = book.pages.filter((page) => {
    const info = pageInfo[page.room] || {};
    return info.hidden !== true && Number.isFinite(info.ops) && info.ops > 0;
  });
  const cover = drawn[drawn.length - 1] || null; // most recent prompt day with art
  return {
    id: book.id,
    event: book.event,
    title: book.title || 'Inktober sketchbook',
    // UNSAVED books are labelled in the gallery ("not saved yet") so the strip
    // also sells the free account: every one of them can be saved by signing up.
    unsaved: isGuestBook(book),
    artistCount: book.artists.length,
    drawnPages: drawn.length,
    pageCount: book.pages.length,
    days: drawn.map((p) => p.day),
    coverRoom: cover ? cover.room : null,
    coverDay: cover ? cover.day : null,
    createdAt: book.createdAt,
    canWatch: true,
  };
}
