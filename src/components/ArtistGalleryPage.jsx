// Artist gallery, the public, searchable index of artist studios
// (audience 'artist_public') plus the verified-account studio creation form.
// Contract: docs/ARTIST-ROOMS-CONTRACT.md.
//
// Data comes from GET /api/rooms/gallery?q=&tag=&event=&offset=&limit= →
//   { rooms: [{ code, title, description, tags, users, ops, event, canWatch }],
//     total, topTags }
// Only explicitly listed, non-moderation-hidden artist rooms appear, and the
// payload carries no account identifiers, emails, or location data, we render
// exactly what the server sends, as plain text.
//
// Studio creation is POST /api/rooms with
//   { audience: "artist_public", title, description, tags, inktober }
// and an Authorization: Bearer token from the session prop. Creation requires
// a verified account; the SERVER is the source of truth for that, when
// accounts are unconfigured it answers accounts_required and we show the
// error instead of faking an identity. Creating a studio does NOT list it in
// this gallery; publishing is a separate explicit owner action (see
// ArtistRoomSettings).
//
// Standalone + reusable: no Router/App imports, no durable local stores. The
// parent wires the route (e.g. /gallery) and passes the props below.
//
// Props:
//   onNavigate(path: string), required; SPA navigation (Router's navigate)
//   session: null | { access_token: string, verified?: boolean, user?: object }
//, signed-in session; null/undefined = guest.
//                                         verified === false shows a verify-account
//                                         notice instead of the create form.
//   pageSize?: number, gallery page size, default 12 (contract max 60)

import { useCallback, useEffect, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import "./artist-rooms.css";

// Client-side bounds mirror the contract's "plain text, bounded lengths/counts".
// The server enforces its own limits and moderation; these keep the UI honest
// and give immediate feedback. Title matches the existing POST /api/rooms cap.
const GALLERY_LIMITS = {
  title: 40,
  description: 280,
  tags: 8,
  tagLength: 24,
  pageMax: 60,
};

const EVENTS = [{ id: "inktober-2026", label: "Inktober 2026" }];

// Deep links: /gallery?q=&tag=&event= pre-select the filters (the Inktober
// page links here with ?event=inktober-2026). Read once at mount; values are
// plain bounded text and the server re-validates everything anyway.
function readInitialFilters() {
  try {
    const p = new URLSearchParams(window.location.search);
    return {
      q: (p.get("q") || "").slice(0, 80),
      tag: (p.get("tag") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, GALLERY_LIMITS.tagLength),
      event: (p.get("event") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40),
    };
  } catch {
    return { q: "", tag: "", event: "" };
  }
}

// Parse a comma-separated tag field into plain lowercase tags. Anything that
// is not letters/numbers/hyphens is stripped, tags are display labels, not
// markup, and the server re-validates.
function parseTags(input) {
  const seen = new Set();
  const out = [];
  String(input || "")
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, GALLERY_LIMITS.tagLength))
    .filter(Boolean)
    .forEach((t) => {
      if (!seen.has(t) && out.length < GALLERY_LIMITS.tags) {
        seen.add(t);
        out.push(t);
      }
    });
  return out;
}

function createErrorMessage(status, payload) {
  const code = payload && (payload.error || payload.code);
  switch (code) {
    case "signin_required":
    case "accounts_required":
      return "Creating an artist studio needs a verified account. Sign in (or ask a grown-up to) and try again.";
    case "verify_email":
    case "unverified":
    case "unverified_account":
      return "Your account email isn't verified yet. Verify it, then create your studio.";
    case "rate_limited":
      return "Too many rooms created just now. Wait a minute and try again.";
    case "profanity":
    case "bad_words":
    case "moderation_rejected":
      return payload.message || "That text didn't pass the language check. Please reword it.";
    case "bad_title":
    case "bad_description":
    case "bad_tags":
      return payload.message || "Some of that text is too long or not allowed. Shorten it and try again.";
    default:
      if (payload && typeof payload.message === "string") return payload.message;
      if (typeof code === "string") return `The server said: ${code}`;
      return status === 401 || status === 403
        ? "The server refused that, you may need a verified account."
        : "Couldn't create the studio right now. Please try again.";
  }
}

export default function ArtistGalleryPage({ onNavigate, session = null, pageSize = 12 }) {
  const limit = Math.min(Math.max(1, pageSize | 0), GALLERY_LIMITS.pageMax) || 12;

  // ------------------------------ gallery feed ------------------------------
  const [initialFilters] = useState(readInitialFilters);
  const [rooms, setRooms] = useState([]);
  const [total, setTotal] = useState(0);
  const [topTags, setTopTags] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [query, setQuery] = useState(initialFilters.q);
  const [activeTag, setActiveTag] = useState(initialFilters.tag);
  const [activeEvent, setActiveEvent] = useState(initialFilters.event);
  const [offset, setOffset] = useState(0);
  const seqRef = useRef(0);

  const load = useCallback((next = {}) => {
    const q = next.q !== undefined ? next.q : query;
    const tag = next.tag !== undefined ? next.tag : activeTag;
    const event = next.event !== undefined ? next.event : activeEvent;
    const off = next.offset !== undefined ? next.offset : offset;
    const seq = ++seqRef.current;
    setStatus("loading");
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (tag) params.set("tag", tag);
    if (event) params.set("event", event);
    if (off) params.set("offset", String(off));
    params.set("limit", String(limit));
    fetch(`/api/rooms/gallery?${params.toString()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`http_${r.status}`))))
      .then((d) => {
        if (seqRef.current !== seq) return;
        setRooms(Array.isArray(d?.rooms) ? d.rooms : []);
        setTotal(typeof d?.total === "number" ? d.total : 0);
        setTopTags(Array.isArray(d?.topTags) ? d.topTags : []);
        setStatus("ready");
      })
      .catch(() => {
        if (seqRef.current !== seq) return;
        setStatus("error");
      });
  }, [query, activeTag, activeEvent, offset, limit]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyFilters = (next) => {
    if (next.q !== undefined) setQuery(next.q);
    if (next.tag !== undefined) setActiveTag(next.tag);
    if (next.event !== undefined) setActiveEvent(next.event);
    setOffset(0);
    load({ ...next, offset: 0 });
  };

  const goPage = (dir) => {
    const next = Math.max(0, Math.min(offset + dir * limit, Math.max(0, total - 1)));
    setOffset(next);
    load({ offset: next });
  };

  // ------------------------------ create form -------------------------------
  const token = session?.access_token || null;
  const unverified = Boolean(session) && (session.verified === false || session.user?.verified === false);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [inktober, setInktober] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [created, setCreated] = useState(null); // { code, title }

  const submitCreate = async (e) => {
    e.preventDefault();
    if (creating || !token) return;
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          audience: "artist_public",
          title: title.trim().slice(0, GALLERY_LIMITS.title),
          description: description.trim().slice(0, GALLERY_LIMITS.description),
          tags: parseTags(tagsInput),
          inktober: Boolean(inktober),
        }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setCreateError(createErrorMessage(res.status, payload));
        return;
      }
      if (payload && payload.code) {
        setCreated({ code: String(payload.code), title: payload.title || title.trim() });
        setTitle("");
        setDescription("");
        setTagsInput("");
        setInktober(false);
      } else {
        setCreateError("The server answered but didn't return a room code. Try again.");
      }
    } catch {
      setCreateError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setCreating(false);
    }
  };

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rooms.length, total);
  const hasFilters = Boolean(query || activeTag || activeEvent);

  return (
    <div className="site-page artist-gallery-page">
      <SiteNav onNavigate={onNavigate} current="/gallery" />
      <main className="site-page-body artist-gallery">
        <h1>Artist studios</h1>
        <p className="site-lead">
          Public studios run by individual artists. Anyone can watch; only the
          artist and the painters they approve can draw.
        </p>

        {/* ----------------------------- filters ----------------------------- */}
        <form
          className="ag-filters"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters({});
          }}
        >
          <label className="ag-search-label" htmlFor="ag-search">Search studios</label>
          <div className="ag-search-row">
            <input
              id="ag-search"
              type="search"
              value={query}
              maxLength={80}
              placeholder="Search titles, descriptions, tags"
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" className="primary-action">Search</button>
          </div>
          <div className="ag-filter-row">
            <label htmlFor="ag-event">Event</label>
            <select
              id="ag-event"
              value={activeEvent}
              onChange={(e) => applyFilters({ event: e.target.value })}
            >
              <option value="">All events</option>
              {EVENTS.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.label}</option>
              ))}
            </select>
            {hasFilters ? (
              <button
                type="button"
                className="ag-clear-filters"
                onClick={() => applyFilters({ q: "", tag: "", event: "" })}
              >
                Clear filters
              </button>
            ) : null}
          </div>
          {topTags.length > 0 ? (
            <div className="ag-toptags" aria-label="Popular tags">
              {topTags.slice(0, 12).map((t) => {
                const name = typeof t === "string" ? t : t?.tag;
                if (!name) return null;
                return (
                  <button
                    key={name}
                    type="button"
                    className={`ag-tag-chip${activeTag === name ? " is-active" : ""}`}
                    aria-pressed={activeTag === name}
                    onClick={() => applyFilters({ tag: activeTag === name ? "" : name })}
                  >
                    #{name}
                  </button>
                );
              })}
            </div>
          ) : null}
          {activeTag ? (
            <p className="ag-active-filter">
              Showing tag <strong>#{activeTag}</strong>
              <button type="button" onClick={() => applyFilters({ tag: "" })}>remove</button>
            </p>
          ) : null}
        </form>

        {/* ------------------------------ results ---------------------------- */}
        <section className="ag-results" aria-live="polite" aria-busy={status === "loading"}>
          {status === "loading" ? (
            <p className="ag-status" role="status">Loading studios…</p>
          ) : null}

          {status === "error" ? (
            <div className="ag-error" role="alert">
              <p>We couldn’t load the gallery just now.</p>
              <button type="button" className="primary-action" onClick={() => load()}>Try again</button>
            </div>
          ) : null}

          {status === "ready" && rooms.length === 0 ? (
            <div className="ag-empty">
              {hasFilters ? (
                <p>No studios match that search. Try different words, or clear the filters.</p>
              ) : (
                <p>
                  No artist studios are listed yet. Yours could be the first -
                  create a studio below and publish it when you’re ready.
                </p>
              )}
            </div>
          ) : null}

          {status === "ready" && rooms.length > 0 ? (
            <>
              <p className="ag-count">Showing {from}–{to} of {total} studios</p>
              <div className="ag-grid">
                {rooms.map((room) => (
                  <article className="ag-card" key={room.code}>
                    <div className="ag-card-head">
                      <span className="ag-card-code" aria-label={`Room code ${room.code}`}>{room.code}</span>
                      {room.event ? (
                        <span className="ag-card-event">
                          {EVENTS.find((e) => e.id === room.event)?.label || room.event}
                        </span>
                      ) : null}
                    </div>
                    <h2 className="ag-card-title">{room.title || `Studio ${room.code}`}</h2>
                    {room.description ? (
                      <p className="ag-card-desc">{room.description}</p>
                    ) : null}
                    {Array.isArray(room.tags) && room.tags.length > 0 ? (
                      <div className="ag-card-tags">
                        {room.tags.slice(0, GALLERY_LIMITS.tags).map((t) => (
                          <button
                            key={t}
                            type="button"
                            className="ag-tag-chip"
                            onClick={() => applyFilters({ tag: t })}
                          >
                            #{t}
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <p className="ag-card-meta">
                      {room.users > 0 ? `${room.users} here now` : "Quiet right now"}
                      {room.ops > 0 ? ` · ${room.ops} brush strokes` : ""}
                    </p>
                    <div className="ag-card-actions">
                      <button
                        type="button"
                        className="primary-action"
                        onClick={() => onNavigate(`/join/${room.code}`)}
                      >
                        Visit studio →
                      </button>
                      {room.canWatch ? (
                        <button
                          type="button"
                          className="ag-watch"
                          onClick={() => onNavigate(`/live/${room.code}`)}
                        >
                          Watch live
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
              <nav className="ag-pager" aria-label="Gallery pages">
                <button type="button" disabled={offset === 0} onClick={() => goPage(-1)}>
                  ← Newer
                </button>
                <button type="button" disabled={to >= total} onClick={() => goPage(1)}>
                  Older →
                </button>
              </nav>
            </>
          ) : null}
        </section>

        {/* --------------------------- create studio -------------------------- */}
        <section className="ag-create" aria-labelledby="ag-create-title">
          <h2 id="ag-create-title">Start your own artist studio</h2>
          {!session ? (
            <p className="ag-signin-note">
              Creating an artist studio needs a verified account, we never fake
              an identity. Sign in, then come back here to open yours. Drawing in
              the commons stays free and anonymous, as always.
            </p>
          ) : unverified ? (
            <p className="ag-signin-note" role="status">
              Your account email isn’t verified yet. Verify it, then you can
              create your studio here.
            </p>
          ) : created ? (
            <div className="ag-created" role="status">
              <p>
                <strong>Your studio is ready, room code {created.code}.</strong>
              </p>
              <p>
                It is <em>not</em> listed in this gallery yet. Open it, paint,
                and publish it from the studio’s settings when you want to be
                discoverable.
              </p>
              <button
                type="button"
                className="primary-action"
                onClick={() => onNavigate(`/join/${created.code}`)}
              >
                Open your studio →
              </button>
              <button type="button" className="ag-secondary" onClick={() => setCreated(null)}>
                Create another
              </button>
            </div>
          ) : !createOpen ? (
            <button type="button" className="primary-action" onClick={() => setCreateOpen(true)}>
              Create an artist studio
            </button>
          ) : (
            <form className="ag-create-form" onSubmit={submitCreate}>
              <p className="ag-create-note">
                Your studio is public to <em>view</em>, only you and painters
                you approve can draw. It won’t appear in this gallery until you
                publish it yourself.
              </p>
              <label htmlFor="ag-new-title">
                Studio title <span className="ag-hint">({GALLERY_LIMITS.title - title.length} left)</span>
              </label>
              <input
                id="ag-new-title"
                type="text"
                value={title}
                required
                maxLength={GALLERY_LIMITS.title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <label htmlFor="ag-new-desc">
                Short description <span className="ag-hint">({GALLERY_LIMITS.description - description.length} left)</span>
              </label>
              <textarea
                id="ag-new-desc"
                value={description}
                rows={3}
                maxLength={GALLERY_LIMITS.description}
                placeholder="What do you paint here? Plain text only."
                onChange={(e) => setDescription(e.target.value)}
              />
              <label htmlFor="ag-new-tags">
                Tags <span className="ag-hint">(up to {GALLERY_LIMITS.tags}, comma separated)</span>
              </label>
              <input
                id="ag-new-tags"
                type="text"
                value={tagsInput}
                placeholder="landscape, pixel-art, cats"
                onChange={(e) => setTagsInput(e.target.value)}
              />
              <label className="ag-inktober-opt">
                <input
                  type="checkbox"
                  checked={inktober}
                  onChange={(e) => setInktober(e.target.checked)}
                />
                <span>
                  Join Inktober 2026, during October this studio uses ink &amp;
                  pencil tools only, with the day’s prompt from the official
                  challenge. Your mural is never wiped when the prompt changes.
                </span>
              </label>
              {createError ? (
                <p className="ag-form-error" role="alert">{createError}</p>
              ) : null}
              <div className="ag-create-actions">
                <button type="submit" className="primary-action" disabled={creating || !title.trim()}>
                  {creating ? "Creating…" : "Create studio"}
                </button>
                <button
                  type="button"
                  className="ag-secondary"
                  disabled={creating}
                  onClick={() => { setCreateOpen(false); setCreateError(""); }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </section>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
