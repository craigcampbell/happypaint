// Artist room settings, the owner-only publishing panel for one artist
// studio (audience 'artist_public'). Contract: docs/ARTIST-ROOMS-CONTRACT.md.
//
// The REST endpoints for this panel (POST /api/rooms/:code/publish and
// /unpublish, plus whatever load endpoint the backend lands) are NOT final
// yet, so this component never fetches directly: the parent injects three
// async callbacks and this component owns only the form state and the
// publish/unpublish confirmation flow. When the backend lands, the parent
// wires the callbacks to fetch() with `Authorization: Bearer <token>`.
//
// Props (concrete interface, all callbacks receive the bearer token, never
// store it, and must throw or reject with an Error whose .message is shown
// verbatim to the owner):
//
//   roomCode: string, required. The studio's room code.
//   session: null | { access_token }, required for any action. null renders
//                                         a sign-in notice and fires NO callbacks.
//   loadPublishInfo: async ({ roomCode, token }) => {
//     listed: boolean,, owner-listed in the public gallery
//     description: string,
//     tags: string[],
//     inktober: boolean,               : Inktober 2026 opt-in for this room
//     publishedAt: string | null,      : ISO timestamp or null
//     moderationHidden: boolean,, hidden by moderators; owner cannot override
//   }
//   publish: async ({ roomCode, token, description, tags, inktober }) =>
//     publish-info object (same shape as loadPublishInfo's result)
//   unpublish: async ({ roomCode, token }) =>
//     publish-info object (same shape)
//   onNavigate?: (path: string) => void, optional, used for the "view studio" link
//
// Behavior guarantees (contract):
//   * Publishing is always an explicit, confirmed action, never implicit.
//   * Unpublishing removes gallery discovery ONLY; the copy states plainly
//     that the room link keeps working ("unlisted still viewable by link").
//   * moderationHidden disables publishing; the owner cannot override it.
//   * Server/moderation errors (profanity, length limits) render verbatim and
//     leave the previous published state untouched (no optimistic flip).

// Limits/tag parsing live in ArtistGalleryPage.jsx; duplicated here (not
// imported) so each component file exports only its component, the repo's
// eslint zero-warnings policy flags mixed component/helper exports.
import { useCallback, useEffect, useRef, useState } from "react";
import "./artist-rooms.css";

const LIMITS = { description: 280, tags: 8, tagLength: 24 };

function parseTags(input) {
  const seen = new Set();
  const out = [];
  String(input || "")
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, LIMITS.tagLength))
    .filter(Boolean)
    .forEach((t) => {
      if (!seen.has(t) && out.length < LIMITS.tags) {
        seen.add(t);
        out.push(t);
      }
    });
  return out;
}

export default function ArtistRoomSettings({
  roomCode,
  session = null,
  loadPublishInfo,
  publish,
  unpublish,
  onNavigate,
}) {
  const token = session?.access_token || null;

  const [info, setInfo] = useState(null); // last known publish-info from the server
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [loadError, setLoadError] = useState("");

  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [inktober, setInktober] = useState(false);

  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState("");
  const [confirm, setConfirm] = useState(null); // null | "publish" | "unpublish"
  const seqRef = useRef(0);

  const applyInfo = useCallback((next) => {
    setInfo(next);
    setDescription(next?.description || "");
    setTagsInput(Array.isArray(next?.tags) ? next.tags.join(", ") : "");
    setInktober(Boolean(next?.inktober));
  }, []);

  const load = useCallback(async () => {
    if (!token || typeof loadPublishInfo !== "function") return;
    const seq = ++seqRef.current;
    setStatus("loading");
    setLoadError("");
    try {
      const next = await loadPublishInfo({ roomCode, token });
      if (seqRef.current !== seq) return;
      applyInfo(next);
      setStatus("ready");
    } catch (err) {
      if (seqRef.current !== seq) return;
      setLoadError(err?.message || "Couldn't load the publishing settings.");
      setStatus("error");
    }
  }, [roomCode, token, loadPublishInfo, applyInfo]);

  useEffect(() => {
    if (token) load();
  }, [token, load]);

  // The actual mutation, run only after the explicit confirm step.
  const runConfirmed = async () => {
    if (saving) return;
    setSaving(true);
    setActionError("");
    try {
      let next;
      if (confirm === "publish") {
        next = await publish({
          roomCode,
          token,
          description: description.trim().slice(0, LIMITS.description),
          tags: parseTags(tagsInput),
          inktober: Boolean(inktober),
        });
      } else {
        next = await unpublish({ roomCode, token });
      }
      if (next && typeof next === "object") applyInfo(next);
      else if (confirm === "unpublish") setInfo((cur) => (cur ? { ...cur, listed: false } : cur));
      setConfirm(null);
    } catch (err) {
      // State is left exactly as the server last reported it, no optimistic flip.
      setActionError(err?.message || "That didn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------ signed out -------------------------------
  if (!token) {
    return (
      <section className="artist-settings" aria-labelledby="ars-title">
        <h2 id="ars-title">Studio publishing</h2>
        <p className="ars-note">
          Sign in as this studio’s owner to manage publishing. We never guess or
          fake an identity.
        </p>
      </section>
    );
  }

  const listed = Boolean(info?.listed);
  const hidden = Boolean(info?.moderationHidden);
  const dirty =
    info &&
    (description.trim() !== (info.description || "") ||
      parseTags(tagsInput).join(",") !== (info.tags || []).join(",") ||
      Boolean(inktober) !== Boolean(info.inktober));

  return (
    <section className="artist-settings" aria-labelledby="ars-title" aria-busy={status === "loading"}>
      <h2 id="ars-title">Studio publishing</h2>

      {status === "loading" ? (
        <p className="ars-status" role="status">Loading publishing settings…</p>
      ) : null}

      {status === "error" ? (
        <div className="ars-error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="primary-action" onClick={load}>Try again</button>
        </div>
      ) : null}

      {status === "ready" && info ? (
        <>
          <p className={`ars-state ${listed ? "ars-state-listed" : "ars-state-unlisted"}`}>
            {listed
              ? `Listed in the public gallery${info.publishedAt ? ` since ${new Date(info.publishedAt).toLocaleDateString()}` : ""}.`
              : "Not listed, this studio does not appear in gallery search."}
          </p>
          {!listed ? (
            <p className="ars-note">
              Unlisted is <strong>not</strong> private: anyone with the room
              link can still view this studio. Listing only controls whether it
              shows up in gallery search.
            </p>
          ) : null}
          {hidden ? (
            <p className="ars-moderation" role="alert">
              Moderators have hidden this studio from the gallery. Publishing
              controls are disabled, this can’t be overridden from here.
            </p>
          ) : null}

          <form
            className="ars-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!hidden && !saving) setConfirm("publish");
            }}
          >
            <label htmlFor="ars-desc">
              Gallery description <span className="ag-hint">({LIMITS.description - description.length} left)</span>
            </label>
            <textarea
              id="ars-desc"
              rows={3}
              value={description}
              maxLength={LIMITS.description}
              disabled={hidden}
              placeholder="Shown in the public gallery. Plain text only."
              onChange={(e) => setDescription(e.target.value)}
            />
            <label htmlFor="ars-tags">
              Tags <span className="ag-hint">(up to {LIMITS.tags}, comma separated)</span>
            </label>
            <input
              id="ars-tags"
              type="text"
              value={tagsInput}
              disabled={hidden}
              placeholder="landscape, pixel-art, cats"
              onChange={(e) => setTagsInput(e.target.value)}
            />
            <label className="ag-inktober-opt">
              <input
                type="checkbox"
                checked={inktober}
                disabled={hidden}
                onChange={(e) => setInktober(e.target.checked)}
              />
              <span>
                Join Inktober 2026, ink &amp; pencil tools only in this studio
                during October. Prompts come from the server; the mural is
                never auto-wiped.
              </span>
            </label>

            {actionError ? (
              <p className="ag-form-error" role="alert">{actionError}</p>
            ) : null}

            {/* ----------------------- confirm step ----------------------- */}
            {confirm === "publish" ? (
              <div className="ars-confirm" role="alertdialog" aria-label="Confirm publishing">
                <p>
                  {listed
                    ? "Save these changes to the public gallery listing?"
                    : "Publish this studio to the public gallery? Anyone will be able to find it in search and watch. Only painters you approve can draw."}
                </p>
                <div className="ars-confirm-actions">
                  <button type="button" className="primary-action" disabled={saving} onClick={runConfirmed}>
                    {saving ? "Saving…" : listed ? "Yes, save changes" : "Yes, publish it"}
                  </button>
                  <button type="button" className="ag-secondary" disabled={saving} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {confirm === "unpublish" ? (
              <div className="ars-confirm" role="alertdialog" aria-label="Confirm unpublishing">
                <p>
                  Remove this studio from gallery search? <strong>The room link
                  keeps working</strong>, anyone who has it can still view the
                  studio. Unpublishing only stops new people discovering it.
                </p>
                <div className="ars-confirm-actions">
                  <button type="button" className="ars-danger" disabled={saving} onClick={runConfirmed}>
                    {saving ? "Removing…" : "Yes, unpublish"}
                  </button>
                  <button type="button" className="ag-secondary" disabled={saving} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {!confirm ? (
              <div className="ars-actions">
                <button
                  type="submit"
                  className="primary-action"
                  disabled={hidden || saving || (listed && !dirty)}
                >
                  {listed ? "Save changes" : "Publish to gallery…"}
                </button>
                {listed ? (
                  <button
                    type="button"
                    className="ars-danger"
                    disabled={hidden || saving}
                    onClick={() => setConfirm("unpublish")}
                  >
                    Unpublish…
                  </button>
                ) : null}
                {onNavigate ? (
                  <button type="button" className="ag-secondary" onClick={() => onNavigate(`/join/${roomCode}`)}>
                    View studio
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>
        </>
      ) : null}
    </section>
  );
}
