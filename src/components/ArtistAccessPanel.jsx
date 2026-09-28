// Artist studio access + publishing UI (audience 'artist_public').
// Contract: docs/ARTIST-ROOMS-CONTRACT.md.
//
// One component, three faces (the studio mounts the one that matches):
//
//   OWNER  — the "Studio" panel: the live paint-request queue (approve by
//            session target id, dismiss), the approved-painter ACL (opaque
//            ids from the owner-only REST settings endpoint, revoke works for
//            online AND offline painters), and the publishing form (the
//            existing ArtistRoomSettings, wired to the real bearer API).
//   VIEWER — a banner over the canvas: guests get "Sign in to request
//            access" (the existing auth UX, preserving the room); signed-in
//            viewers get a "Request paint access" button and the server's
//            pending/revoked answers.
//   PAINTER — an approved non-owner: a small "you can paint" chip.
//
// This component never fetches directly and never stores the token: every
// network call is an injected async callback (the parent wires them to
// fetch() with `Authorization: Bearer …`), matching ArtistRoomSettings'
// callback contract. Callbacks must throw/reject with an Error whose
// .message is shown verbatim.
//
// Props:
//   roomCode: string (required)
//   roomTitle?: string | null
//   isOwner: boolean (required) — owner face vs viewer/painter face
//   canPaint: boolean (required) — server-authoritative (handshake/role_changed)
//   session: null | { access_token } — null = guest (sign-in CTA)
//   roomProfile?: null | { description, tags, event } — public studio profile
//   paintRequests?: [{ userId, name, ts }] — owner-only live queue
//   paintStatus?: null | "pending" | "approved" | "revoked" | "already"
//   // Owner callbacks:
//   loadPublishInfo / publish / unpublish — ArtistRoomSettings' contract
//   onApprove(userId), onDismiss(userId) — live WS decisions by session id
//   onRevokePainter(profileId) — REST ACL revoke (online + offline)
//   // Viewer callbacks:
//   onRequestAccess() — send paint_request
//   onSignIn() — navigate to the existing sign-in UX preserving this room
import { useCallback, useEffect, useRef, useState } from "react";
import ArtistRoomSettings from "./ArtistRoomSettings";
import "./artist-access.css";

// Short, non-identifying label for an opaque painter id (owner's own ACL
// management — the id itself is meaningless to anyone else).
const shortId = (pid) => (pid.length <= 10 ? pid : `${pid.slice(0, 6)}…${pid.slice(-4)}`);

export default function ArtistAccessPanel({
  roomCode,
  roomTitle = null,
  isOwner,
  canPaint,
  session = null,
  roomProfile = null,
  paintRequests = [],
  paintStatus = null,
  loadPublishInfo,
  publish,
  unpublish,
  onApprove,
  onDismiss,
  onRevokePainter,
  onRequestAccess,
  onSignIn,
}) {
  // ---- owner: approved-painter ACL (refresh after every decision) --------
  const [painters, setPainters] = useState(null); // null = loading
  const [paintersError, setPaintersError] = useState("");
  const [busyId, setBusyId] = useState(null); // a revoke in flight
  const seqRef = useRef(0);

  const refreshPainters = useCallback(async () => {
    if (!isOwner || typeof loadPublishInfo !== "function") return;
    const seq = ++seqRef.current;
    setPaintersError("");
    try {
      const info = await loadPublishInfo({ roomCode, token: session?.access_token });
      if (seqRef.current !== seq) return;
      setPainters(Array.isArray(info?.painters) ? info.painters : []);
    } catch (err) {
      if (seqRef.current !== seq) return;
      setPaintersError(err?.message || "Couldn't load the painter list.");
    }
  }, [isOwner, loadPublishInfo, roomCode, session?.access_token]);

  useEffect(() => {
    if (isOwner) refreshPainters();
  }, [isOwner, refreshPainters]);

  const decide = async (kind, id) => {
    if (busyId) return;
    setBusyId(id);
    try {
      if (kind === "approve") await onApprove?.(id);
      else if (kind === "dismiss") await onDismiss?.(id);
      else if (kind === "revoke") await onRevokePainter?.(id);
      await refreshPainters();
    } catch (err) {
      setPaintersError(err?.message || "That didn't save. Please try again.");
    } finally {
      setBusyId(null);
    }
  };

  // ================================ OWNER =================================
  if (isOwner) {
    return (
      <div className="aap-owner">
        <section className="aap-section" aria-labelledby="aap-req-title">
          <h3 id="aap-req-title">Paint requests</h3>
          {paintRequests.length === 0 ? (
            <p className="aap-note">No one is asking to paint right now. Requests from signed-in watchers show up here.</p>
          ) : (
            <ul className="aap-request-list">
              {paintRequests.map((req) => (
                <li key={req.userId} className="aap-request">
                  <span className="aap-request-name">{req.name || "A watcher"}</span>
                  <span className="aap-request-actions">
                    <button
                      type="button"
                      className="primary-action"
                      disabled={busyId === req.userId}
                      onClick={() => decide("approve", req.userId)}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="aap-secondary"
                      disabled={busyId === req.userId}
                      onClick={() => decide("dismiss", req.userId)}
                    >
                      Dismiss
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="aap-section" aria-labelledby="aap-painters-title">
          <h3 id="aap-painters-title">Approved painters</h3>
          <p className="aap-note">
            Approved painters can draw in this studio — they never get host or moderation powers.
            Revoking works whether they&apos;re here now or offline.
          </p>
          {paintersError ? (
            <p className="aap-error" role="alert">{paintersError}</p>
          ) : null}
          {painters === null ? (
            <p className="aap-note" role="status">Loading painters…</p>
          ) : painters.length === 0 ? (
            <p className="aap-note">Nobody approved yet — you&apos;re the only brush in here.</p>
          ) : (
            <ul className="aap-painter-list">
              {painters.map((pid) => (
                <li key={pid} className="aap-painter">
                  <span className="aap-painter-id" title={`Painter account ${pid}`}>🖌 {shortId(pid)}</span>
                  <button
                    type="button"
                    className="aap-danger"
                    disabled={busyId === pid}
                    onClick={() => decide("revoke", pid)}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <ArtistRoomSettings
          roomCode={roomCode}
          session={session}
          loadPublishInfo={loadPublishInfo}
          publish={publish}
          unpublish={unpublish}
        />
      </div>
    );
  }

  // ============================ APPROVED PAINTER ===========================
  if (canPaint) {
    return (
      <div className="aap-chip aap-chip-painter" role="note">
        🖌 You can paint in {roomTitle ? `“${roomTitle}”` : "this studio"} — the artist approved you.
      </div>
    );
  }

  // ================================ VIEWER =================================
  const profileLine = roomProfile?.description
    ? roomProfile.description
    : "Only the artist and painters they approve can draw here.";

  return (
    <div className="aap-banner" role="note" aria-label="You're watching an artist studio">
      <div className="aap-banner-text">
        <strong>👀 Watching {roomTitle ? `“${roomTitle}”` : "an artist studio"}</strong>
        <span className="aap-banner-sub">{profileLine}</span>
      </div>
      <div className="aap-banner-actions">
        {!session ? (
          <button type="button" className="primary-action" onClick={onSignIn}>
            🔑 Sign in to request access
          </button>
        ) : paintStatus === "pending" ? (
          <span className="aap-status-pill" role="status">⏳ Request sent — the artist will see it in their Studio panel</span>
        ) : paintStatus === "revoked" ? (
          <>
            <span className="aap-status-pill" role="status">The artist hasn&apos;t approved painting right now — enjoy the show!</span>
            <button type="button" className="aap-secondary" onClick={onRequestAccess}>
              Ask again
            </button>
          </>
        ) : (
          <button type="button" className="primary-action" onClick={onRequestAccess}>
            🖌 Request paint access
          </button>
        )}
      </div>
    </div>
  );
}
