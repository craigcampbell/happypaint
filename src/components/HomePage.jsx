// The new homepage: a live, read-only window into an active public room so every
// visitor immediately sees art being made. A top nav links to the other pages;
// a search dropdown switches which public room you're watching; a room-code box
// jumps straight in; clicking the canvas opens a Join modal.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import LiveRoomCanvas from "./LiveRoomCanvas";

const normalizeCode = (raw) => (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

export default function HomePage({ onNavigate }) {
  const [rooms, setRooms] = useState([]);
  const [activeCode, setActiveCode] = useState(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [code, setCode] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const liveOpsRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/rooms/public", { cache: "no-store" });
      const data = await res.json();
      const list = Array.isArray(data?.rooms) ? data.rooms : [];
      setRooms(list);
      setActiveCode((cur) => {
        if (cur && list.some((r) => r.code === cur)) return cur;
        // Lead with the liveliest room: most painters, then most art.
        const best = [...list].sort((a, b) => b.users - a.users || b.ops - a.ops)[0];
        return best ? best.code : null;
      });
    } catch {
      /* offline — leave as-is */
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 15000); // keep the lobby fresh
    return () => window.clearInterval(t);
  }, [refresh]);

  const active = useMemo(() => rooms.find((r) => r.code === activeCode) || null, [rooms, activeCode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) => `${r.title || ""} ${r.code} ${r.prompt || ""}`.toLowerCase().includes(q));
  }, [rooms, query]);

  const join = (c) => onNavigate(`/join/${c}`);

  const goByCode = (event) => {
    event.preventDefault();
    const c = normalizeCode(code);
    if (c) join(c);
  };

  return (
    <div className="home-page">
      <SiteNav onNavigate={onNavigate} current="/" />

      <main className="home-main">
        <div className="home-headline">
          <p className="eyebrow">🟢 Live now — no account needed</p>
          <h1>Watch the studio, then jump in.</h1>
          <p className="home-sub">
            Real kids and friends painting together right now. Tap the canvas to join, search for a room,
            or punch in a room code.
          </p>
        </div>

        <div className="home-stage">
          <div className="home-viewer-head">
            <span className="home-viewing">
              <span className="live-dot" aria-hidden="true" /> Viewing public room
            </span>
            <strong className="home-room-name">
              {active ? `${active.emoji || "🎨"} ${active.title || active.code}` : "Finding an open room…"}
            </strong>
            {active?.prompt ? <span className="home-room-prompt">“{active.prompt}”</span> : null}
            <span className="home-room-meta">
              {active ? `${active.users} painting · ${active.ops} strokes` : ""}
            </span>
          </div>

          <button
            type="button"
            className="home-viewer"
            onClick={() => active && setShowJoin(true)}
            aria-label={active ? `Join ${active.title || active.code}` : "Loading room"}
          >
            {activeCode ? (
              <LiveRoomCanvas roomCode={activeCode} onActivity={(n) => { liveOpsRef.current = n; }} />
            ) : (
              <div className="home-viewer-empty">Loading live artwork…</div>
            )}
            <span className="home-viewer-cta">✏️ Tap to join &amp; paint</span>
          </button>

          <div className="home-controls">
            <div className="home-browse">
              <button type="button" className="home-browse-btn" onClick={() => setBrowseOpen((o) => !o)} aria-expanded={browseOpen}>
                🔍 Browse rooms ({rooms.length})
              </button>
              {browseOpen ? (
                <div className="home-browse-panel">
                  <input
                    type="search"
                    autoFocus
                    value={query}
                    placeholder="Search rooms or prompts…"
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="home-browse-list">
                    {filtered.length === 0 ? <p className="home-browse-empty">No rooms match.</p> : null}
                    {filtered.map((r) => (
                      <button
                        type="button"
                        key={r.code}
                        className={r.code === activeCode ? "is-active" : ""}
                        onClick={() => {
                          setActiveCode(r.code);
                          setBrowseOpen(false);
                        }}
                      >
                        <span className="home-browse-emoji" aria-hidden="true">{r.emoji || "🎨"}</span>
                        <span className="home-browse-name">{r.title || r.code}</span>
                        <span className="home-browse-count">{r.users > 0 ? `${r.users} 🖌️` : "open"}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <form className="home-code" onSubmit={goByCode}>
              <input
                type="text"
                value={code}
                placeholder="Have a room code?"
                maxLength={8}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button type="submit" className="primary-action">Go →</button>
            </form>
          </div>
        </div>
      </main>

      {showJoin && active ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowJoin(false)}>
          <section
            className="studio-modal home-join-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-join-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="home-join-close" onClick={() => setShowJoin(false)} aria-label="Close">✕</button>
            <div className="home-join-emoji" aria-hidden="true">{active.emoji || "🎨"}</div>
            <h2 id="home-join-title">Join “{active.title || active.code}”?</h2>
            {active.prompt ? <p className="home-join-prompt">Today’s prompt: “{active.prompt}”</p> : null}
            <p className="home-join-summary">
              {active.users > 0 ? `${active.users} painting right now` : "Be the first one painting"} ·{" "}
              {active.ops} brushstrokes so far
            </p>
            <div className="home-join-actions">
              <button type="button" className="primary-action" onClick={() => join(active.code)}>
                Continue as guest →
              </button>
              <div className="home-join-auth">
                <button type="button" onClick={() => onNavigate("/signup")}>Log in</button>
                <button type="button" onClick={() => onNavigate("/signup")}>Sign up free</button>
              </div>
            </div>
            <p className="home-join-note">No account needed to draw — sign up only to save your gallery.</p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
