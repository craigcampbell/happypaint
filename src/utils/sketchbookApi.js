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
// PRIVATE). Resume ignores it — an existing book comes back unchanged, so a
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

// The paginated public gallery. offset/limit with an honest total — the
// caller walks pages ("load more"), there is no silent cap.
export function fetchSketchbookGallery(offset = 0, limit = 12) {
  return apiFetch(
    `/api/sketchbooks?event=${encodeURIComponent(SKETCHBOOK_EVENT)}&offset=${offset}&limit=${limit}`,
  );
}

// Banner data for one page room (404 not_a_page for ordinary rooms).
export function fetchSketchbookByRoom(roomCode, session = null) {
  return apiFetch(`/api/sketchbooks/by-room/${encodeURIComponent(roomCode)}`, { session });
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
