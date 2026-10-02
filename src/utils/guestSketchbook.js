// Unsaved (guest) sketchbook record, the device's one local bookmark for the
// book it started without an account (docs/SKETCHBOOKS-CONTRACT.md §"Unsaved
// (guest) public sketchbooks").
//
// The server hands the one-time save token (`sbkc_…`) back EXACTLY ONCE, on
// first creation. This module is the only place that touches the localStorage
// record: write it the moment the token arrives, read it when a session
// appears (auto-claim), clear it once the book is saved (or provably
// unclaimable) so we never claim twice.
//
// Wipe coverage: 'drawesome:guestbook:v1' is listed in utils/accountDeletion.js
// (AGENTS.md: every durable client store must be wiped on account deletion).

export const GUEST_SKETCHBOOK_KEY = "drawesome:guestbook:v1";

// The per-browser device key the WS auth frame already sends as userKey
// (src/hooks/useMultiplayer.js). THE shared id, never invent a second one.
// Matches the format there: created on first read, `dk_…` / `u_…` prefixed.
export function getDeviceKey() {
  try {
    let key = window.localStorage.getItem("drawesome:userkey:v1");
    if (!key) {
      key = `dk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      window.localStorage.setItem("drawesome:userkey:v1", key);
    }
    return key;
  } catch {
    return "";
  }
}

// The stored record: { bookId, token } | null. Tolerant of junk/legacy values.
export function readGuestSketchbook() {
  try {
    const raw = window.localStorage.getItem(GUEST_SKETCHBOOK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const bookId = typeof parsed.bookId === "string" ? parsed.bookId : "";
    const token = typeof parsed.token === "string" ? parsed.token : "";
    if (!bookId || !token) return null;
    return { bookId, token };
  } catch {
    return null;
  }
}

// Persist the record right after a successful guest create/resume. The token
// only rides the FIRST creation reply, if it's there, this is the only chance
// to keep it. A resume reply without a token keeps any record we already hold.
export function saveGuestSketchbook(payload) {
  if (!payload?.bookId) return readGuestSketchbook();
  const token = typeof payload.token === "string" && payload.token ? payload.token : null;
  const existing = readGuestSketchbook();
  // Never overwrite a known token with nothing: a resume (or a second tab that
  // missed the creation reply) must not destroy the one copy we have.
  const record = { bookId: payload.bookId, token: token || existing?.token || "" };
  if (!record.token) return null; // nothing durable to store
  try {
    window.localStorage.setItem(GUEST_SKETCHBOOK_KEY, JSON.stringify(record));
  } catch {
    /* storage blocked, the book stays unsaved-but-drawable, honestly so */
  }
  return record;
}

export function clearGuestSketchbook() {
  try {
    window.localStorage.removeItem(GUEST_SKETCHBOOK_KEY);
  } catch {
    /* best-effort */
  }
}
