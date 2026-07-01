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
  const [joinRoom, setJoinRoom] = useState(null); // frozen snapshot of the room the modal is for
  const liveOpsRef = useRef(0);
  // Mirrored into refs so timers/callbacks read the latest without being deps.
  const roomsRef = useRef([]);
  roomsRef.current = rooms;
  const showJoinRef = useRef(false);
  showJoinRef.current = showJoin;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/rooms/public", { cache: "no-store" });
      const data = await res.json();
      const list = Array.isArray(data?.rooms) ? data.rooms : [];
      setRooms(list);
      setActiveCode((cur) => {
        // Don't swap the room out from under an open join modal.
        if (showJoinRef.current && cur) return cur;
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
    const t = window.setInterval(() => {
      if (document.hidden) return; // don't poll a backgrounded tab
      refresh();
    }, 15000); // keep the lobby fresh
    return () => window.clearInterval(t);
  }, [refresh]);

  // Stable so LiveRoomCanvas (which keys its socket effect on onActivity) doesn't
  // tear down + reopen the spectator WS on every parent re-render.
  const onLiveActivity = useCallback((n) => {
    liveOpsRef.current = n;
  }, []);

  // Auto-tour open rooms: every 30s hop the live viewport to another public room
  // so the homepage always feels active. Pauses while the join modal or the
  // browse dropdown is open. Reads rooms via a ref so the 15s refresh() (which
  // replaces the rooms array every poll) can't restart/starve this 30s timer.
  useEffect(() => {
    if (showJoin || browseOpen) return undefined;
    const t = window.setInterval(() => {
      if (document.hidden) return; // no point touring a hidden tab
      const list = roomsRef.current;
      if (list.length < 2) return;
      setActiveCode((cur) => {
        const others = list.filter((r) => r.code !== cur);
        if (others.length === 0) return cur;
        // Prefer rooms with painters; fall back to any other room. Pseudo-random
        // pick so the tour doesn't feel like a fixed loop.
        const lively = others.filter((r) => r.users > 0);
        const pool = lively.length ? lively : others;
        return pool[Math.floor(Math.random() * pool.length)].code;
      });
    }, 30000);
    return () => window.clearInterval(t);
  }, [showJoin, browseOpen]);

  const touring = rooms.length >= 2 && !showJoin && !browseOpen;

  const active = useMemo(() => rooms.find((r) => r.code === activeCode) || null, [rooms, activeCode]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) => `${r.title || ""} ${r.code} ${r.prompt || ""}`.toLowerCase().includes(q));
  }, [rooms, query]);

  const join = (c) => onNavigate(`/join/${c}`);

  // Fresh 6-char code from an unambiguous alphabet (no I/O/0/1) — joining a
  // code that doesn't exist yet is how private rooms get created.
  const startRoom = () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let c = "";
    for (let i = 0; i < 6; i += 1) c += alphabet[Math.floor(Math.random() * alphabet.length)];
    join(c);
  };

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
            Real people painting together, live. Tap the canvas to jump in — or start a room just for
            you and your friends.
          </p>
        </div>

        <div className="home-stage">
          <div className="home-viewer-head">
            <span className="home-viewing">
              <span className="live-dot" aria-hidden="true" />{" "}
              {touring ? "Touring open rooms" : "Viewing public room"}
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
            onClick={() => { if (active) { setJoinRoom(active); setShowJoin(true); } }}
            aria-label={active ? `Join ${active.title || active.code}` : "Loading room"}
          >
            {activeCode ? (
              <LiveRoomCanvas roomCode={activeCode} onActivity={onLiveActivity} />
            ) : (
              <div className="home-viewer-empty">Loading live artwork…</div>
            )}
            <span className="home-viewer-cta">✏️ Tap to join &amp; paint</span>
          </button>

          <div className="home-controls">
            <button type="button" className="primary-action home-start-room" onClick={startRoom}>
              🎪 Start a room with friends
            </button>
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

      {showJoin && joinRoom ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowJoin(false)}>
          <section
            className="studio-modal home-join-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="home-join-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="home-join-close" onClick={() => setShowJoin(false)} aria-label="Close">✕</button>
            <div className="home-join-emoji" aria-hidden="true">{joinRoom.emoji || "🎨"}</div>
            <h2 id="home-join-title">Join “{joinRoom.title || joinRoom.code}”?</h2>
            {joinRoom.prompt ? <p className="home-join-prompt">Today’s prompt: “{joinRoom.prompt}”</p> : null}
            <p className="home-join-summary">
              {joinRoom.users > 0 ? `${joinRoom.users} painting right now` : "Be the first one painting"} ·{" "}
              {joinRoom.ops} brushstrokes so far
            </p>
            <div className="home-join-actions">
              <button type="button" className="primary-action" onClick={() => join(joinRoom.code)}>
                Continue as guest →
              </button>
              <div className="home-join-auth">
                <button type="button" onClick={() => onNavigate("/signup?mode=login")}>Log in</button>
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
