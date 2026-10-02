// Sketchbook API client (docs/SKETCHBOOKS-CONTRACT.md).
//
// Thin fetch wrappers for the Inktober sketchbook REST surface. Auth rides
// the PocketBase session exactly like the artist-gallery calls
// (Authorization: Bearer <access_token>); every endpoint also answers
// without one for the public read paths. Components stay fixture-testable:
// these functions only shape requests, they never hold state.

export const SKETCHBOOK_EVENT = "inktober-2026";

async function apiFetch(path, { method = "GET", session = null, body = null } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      cache: "no-store",
      body: body == null ? null : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, json: null, error: "offline" };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, error: json?.error || null };
}

// Create OR resume the caller's book. Visibility is EXPLICIT: `public` is a
// real boolean in the body every time (the server defaults omitted/false to
// PRIVATE). Resume ignores it, an existing book comes back unchanged, so a
// re-click can never silently flip an older book's visibility.
export function createOrResumeSketchbook(session, { isPublic = false, title = "" } = {}) {
  return apiFetch("/api/sketchbooks", {
    method: "POST",
    session,
    body: { event: SKETCHBOOK_EVENT, public: isPublic === true, ...(title ? { title } : {}) },
  });
}

// Owner-only visibility switch. The server returns the fresh owner view; a
// public→private downgrade immediately sweeps strangers out of every page
// room server-side.
export function setSketchbookVisibility(bookId, isPublic, session) {
  return apiFetch(`/api/sketchbooks/${encodeURIComponent(bookId)}/visibility`, {
    method: "POST",
    session,
    body: { public: isPublic === true },
  });
}

export function fetchMySketchbook(session) {
  return apiFetch(`/api/sketchbooks/mine?event=${encodeURIComponent(SKETCHBOOK_EVENT)}`, { session });
}

// Public book reader (owner view when the session owns it).
export function fetchSketchbook(bookId, session = null) {
  return apiFetch(`/api/sketchbooks/${encodeURIComponent(bookId)}`, { session });
}

// The paginated public gallery. offset/limit with an honest total, the
// caller walks pages ("load more"), there is no silent cap.
export function fetchSketchbookGallery(offset = 0, limit = 12) {
  return apiFetch(
    `/api/sketchbooks?event=${encodeURIComponent(SKETCHBOOK_EVENT)}&offset=${offset}&limit=${limit}`,
  );
}

// Banner data for one page room (404 not_a_page for ordinary rooms). The
// optional `deviceKey` is THIS browser's own key ('drawesome:userkey:v1', the
// same one the WS auth frame sends): for an UNSAVED (guest) book's page it is
// the only way the server can tell the caller "this is your device's book"
// (unsaved/isGuestOwner/canDraw). It never widens access to anyone else.
export function fetchSketchbookByRoom(roomCode, session = null, deviceKey = null) {
  const dk = deviceKey ? `?dk=${encodeURIComponent(deviceKey)}` : "";
  return apiFetch(`/api/sketchbooks/by-room/${encodeURIComponent(roomCode)}${dk}`, { session });
}

export function addSketchbookPage(bookId, day, session) {
  return apiFetch(`/api/sketchbooks/${encodeURIComponent(bookId)}/pages`, {
    method: "POST",
    session,
    body: day == null ? {} : { day },
  });
}

export function mintSketchbookInvite(bookId, session) {
  return apiFetch(`/api/sketchbooks/${encodeURIComponent(bookId)}/invites`, { method: "POST", session });
}

export function revokeSketchbookInvite(bookId, inviteId, session) {
  return apiFetch(
    `/api/sketchbooks/${encodeURIComponent(bookId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
    { method: "POST", session },
  );
}

export function revokeSketchbookArtist(bookId, profileId, session) {
  return apiFetch(`/api/sketchbooks/${encodeURIComponent(bookId)}/artists/revoke`, {
    method: "POST",
    session,
    body: { profileId },
  });
}

export function acceptSketchbookInvite(token, session) {
  return apiFetch("/api/sketchbooks/accept", { method: "POST", session, body: { token } });
}

// MINT or RESUME this DEVICE's unsaved (guest) book and the page for `day`
// (today's prompt while the event is active when day is omitted; the server
// answers need_day/bad_day outside it). NO account needed. The reply carries
// `token` ONCE, on first creation only: it is the book's one-time save token
// and must be persisted immediately (utils/guestSketchbook.js) or the book can
// never be claimed.
export function startGuestSketchbook({ device, day = null } = {}) {
  return apiFetch("/api/sketchbooks/guest", {
    method: "POST",
    body: { device, ...(day == null ? {} : { day }) },
  });
}

// Save (claim) a device-started book under the signed-in account. The account
// adopts the book; if it already has one for the event the unsaved pages MERGE
// into it. 400 bad_token / 404 claim_invalid for an unknown or spent token.
export function claimSketchbook(token, session) {
  return apiFetch("/api/sketchbooks/claim", { method: "POST", session, body: { token } });
}
