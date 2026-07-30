// The new homepage: a live, read-only window into an active public room so every
// visitor immediately sees art being made. A top nav links to the other pages;
// the in-flow room directory shows every public room; a room-code box jumps
// straight in; clicking the canvas or a room thumbnail opens a Join modal.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import LiveRoomCanvas from "./LiveRoomCanvas";
import BrandMark from "./BrandMark";
import { getSession, onAuthStateChange } from "../utils/auth";
import { resolvePreviewTheme } from "../utils/artPreview";

const normalizeCode = (raw) => (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
const ROOM_TONES = ["coral", "blue", "mint", "lilac", "yellow", "pink"];
const compactNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function roomTone(code) {
  const score = [...String(code || "")].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return ROOM_TONES[score % ROOM_TONES.length];
}

function roomActivity(room) {
  if (room.users === 1) return "1 painting";
  if (room.users > 1) return `${room.users} painting`;
  return "Open";
}

// The device-local drawing streak (written by the studio on the first stroke of
// each day). Shown only while it's alive: last drew today, or yesterday (still
// extendable today). Older = quietly expired, show nothing.
function readStreak() {
  try {
    const saved = JSON.parse(localStorage.getItem("drawesome:streak:v1") || "null");
    if (!saved || !saved.count) return 0;
    const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const today = day(now);
    // Calendar arithmetic (DST-proof) — see bumpDrawingStreak in App.jsx.
    const yesterday = day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    return saved.last === today || saved.last === yesterday ? Number(saved.count) || 0 : 0;
  } catch {
    return 0;
  }
}

// "New challenge in 9h 32m" — minute precision is plenty for a daily timer.
function untilLabel(endsAt) {
  const ms = Math.max(0, endsAt - Date.now());
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function HomePage({ onNavigate }) {
  const [rooms, setRooms] = useState([]);
  const [activeCode, setActiveCode] = useState(null);
  const [query, setQuery] = useState("");
  const [code, setCode] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const [joinRoom, setJoinRoom] = useState(null); // frozen snapshot of the room the modal is for
  const [wallPosts, setWallPosts] = useState([]); // recent Fridge Wall art for the nudge
  const [wallLoaded, setWallLoaded] = useState(false);
  // The Daily Challenge: today's prompt + gallery of entries + a countdown tick.
  const [daily, setDaily] = useState(null);
  const [dailyEntries, setDailyEntries] = useState([]);
  const [, setCountTick] = useState(0); // re-render for the countdown label
  // State (not a one-shot memo) so a tab left open across midnight can refresh
  // the chip when the challenge rolls over below.
  const [streak, setStreak] = useState(readStreak);
  const liveOpsRef = useRef(0);
  // Mirrored into refs so timers/callbacks read the latest without being deps.
  const roomsRef = useRef([]);
  roomsRef.current = rooms;
  const showJoinRef = useRef(false);
  showJoinRef.current = showJoin;
  // Signed-in visitors get one "jump in" button in the join modal instead of
  // the guest/log-in/sign-up spread (same pattern as SiteNav).
  const [session, setSession] = useState(null);
  useEffect(() => {
    let active = true;
    getSession().then((v) => active && setSession(v));
    const unsub = onAuthStateChange((v) => active && setSession(v));
    return () => {
      active = false;
      unsub();
    };
  }, []);

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

  // A peek at the community wall drives the loop: see art → make art → post it.
  // Fetched once (the wall changes slowly); wallLoaded gates the empty-state so
  // it doesn't flash before the request lands.
  useEffect(() => {
    let active = true;
    fetch("/api/wall?sort=fresh&limit=8", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active) return;
        setWallPosts(Array.isArray(d?.posts) ? d.posts : []);
        setWallLoaded(true);
      })
      .catch(() => active && setWallLoaded(true));
    return () => {
      active = false;
    };
  }, []);

  // Today's challenge + its gallery. Refetched when the countdown crosses
  // midnight (the tick effect below re-runs this when daily.endsAt passes).
  useEffect(() => {
    let active = true;
    fetch("/api/daily", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active || !d || !d.prompt) return;
        setDaily(d);
        return fetch(`/api/wall?challenge=${d.date}&sort=new&limit=10`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((g) => active && setDailyEntries(Array.isArray(g?.posts) ? g.posts : []));
      })
      .catch(() => { /* offline — the card just doesn't render */ });
    return () => {
      active = false;
    };
  }, []);

  // Tick the countdown label once a minute; if midnight passed, pull the fresh
  // challenge so a long-lived tab rolls over on its own. Rollover is accepted
  // only when the DATE actually changed — a client clock running fast would
  // otherwise wipe the gallery strip and refetch-loop every minute until real
  // (server) midnight.
  useEffect(() => {
    if (!daily) return undefined;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      if (Date.now() >= daily.endsAt) {
        fetch("/api/daily", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d || !d.prompt || d.date === daily.date) return; // not actually a new day yet
            setDaily(d);
            setStreak(readStreak()); // the chip's "alive" window shifted too
            return fetch(`/api/wall?challenge=${d.date}&sort=new&limit=10`, { cache: "no-store" })
              .then((r) => (r.ok ? r.json() : null))
              .then((g) => setDailyEntries(Array.isArray(g?.posts) ? g.posts : []));
          })
          .catch(() => { /* retry next tick */ });
      } else {
        setCountTick((n) => n + 1);
      }
    }, 60_000);
    return () => window.clearInterval(t);
  }, [daily]);

  // Stable so LiveRoomCanvas (which keys its socket effect on onActivity) doesn't
  // tear down + reopen the spectator WS on every parent re-render.
  const onLiveActivity = useCallback((n) => {
    liveOpsRef.current = n;
  }, []);

  // Auto-tour open rooms: every 30s hop the live viewport to another public room
  // so the homepage always feels active. Pauses while the join modal is open.
  // Reads rooms via a ref so the 15s refresh() (which
  // replaces the rooms array every poll) can't restart/starve this 30s timer.
  useEffect(() => {
    if (showJoin) return undefined;
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
  }, [showJoin]);

  const touring = rooms.length >= 2 && !showJoin;

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

  const startStorybook = async () => {
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audience: "friends", mode: "storybook", title: "Our Story" }),
      });
      const data = await res.json();
      if (!res.ok || !data.code) throw new Error("create failed");
      join(data.code);
    } catch {
      // A normal private room is still a useful anonymous fallback if the
      // mode endpoint is unavailable during a rolling deploy.
      startRoom();
    }
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
          <BrandMark className="home-brand-art" showName={false} />
          <div className="home-headline-copy">
            <p className="eyebrow"><span aria-hidden="true">●</span> Live creative rooms</p>
            <h1>Draw it. Remix it. <span>Make it yours.</span></h1>
            <p className="home-kicker">A live canvas for your people.</p>
            <p className="home-sub">
              Made for your pencil, your group chat, and ideas that refuse to sit still. Jump in—no account needed.
            </p>
            <div className="home-proof-row" aria-label="Drawesome highlights">
              <span>✦ Pen-ready</span>
              <span>↗ Draw live</span>
              <span>⚡ Start in seconds</span>
            </div>
          </div>
        </div>

        <div className="home-stage">
          <div className="home-viewer-head">
            <span className="home-viewing">
              <span className="live-dot" aria-hidden="true" />{" "}
              {touring ? "Room tour" : "Live now"}
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
            <span className="home-viewer-cta">Jump into this canvas →</span>
          </button>

          <div className="home-controls">
            <button type="button" className="primary-action home-open-studio" onClick={() => onNavigate("/studio")}>
              Start drawing
            </button>
            <button type="button" className="home-start-room" onClick={startRoom}>
              Create a room
            </button>
            <button type="button" className="home-start-room" onClick={startStorybook}>
              📖 Start a storybook
            </button>

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

        {/* Today's Challenge — the reason to come back tomorrow. One fresh
            prompt a day; entries hang in today's gallery right here. */}
        {daily ? (
          <section className="home-daily" aria-labelledby="home-daily-title">
            <div className="home-daily-head">
              <div className="home-daily-copy">
                <p className="eyebrow">
                  ✦ Daily drop
                  {streak >= 2 ? <span className="home-streak" title="Days in a row you've drawn">🔥 {streak}-day streak</span> : null}
                </p>
                <h2 id="home-daily-title">
                  <span className="home-daily-emoji" aria-hidden="true">{daily.emoji}</span> {daily.prompt}
                </h2>
                <p className="home-daily-sub">
                  {daily.entries > 0
                    ? `${compactNumber.format(daily.entries)} ${daily.entries === 1 ? "drawing hangs" : "drawings hang"} in today's gallery.`
                    : "Nobody has drawn it yet — be the first!"}{" "}
                  New challenge in <strong>{untilLabel(daily.endsAt)}</strong>.
                </p>
              </div>
              <div className="home-daily-actions">
                <button type="button" className="primary-action home-daily-go" onClick={() => join("DAILY")}>
                  Draw today&rsquo;s prompt →
                </button>
              </div>
            </div>
            {dailyEntries.length > 0 ? (
              <button
                type="button"
                className="home-wall-strip home-daily-strip"
                onClick={() => onNavigate("/wall")}
                aria-label="See today's challenge gallery on the Wall"
              >
                {dailyEntries.map((p) => (
                  <span className="home-wall-tile" key={p.id}>
                    {/* Below the fold — lazy keeps them off the first paint. */}
                    <img src={`/api/wall/${p.id}/frame/0`} alt={p.title} loading="lazy" decoding="async" />
                  </span>
                ))}
                <span className="home-wall-more">Today&rsquo;s<br />gallery →</span>
              </button>
            ) : null}
          </section>
        ) : null}

        {/* Fridge Wall nudge — the community loop's front door. Peeks real
            recent art (or invites the first post when the wall is bare). */}
        <section className="home-wall">
          <div className="home-wall-head">
            <div className="home-wall-copy">
              <p className="eyebrow">✦ Fresh from the community</p>
              <h2>Your art deserves the spotlight.</h2>
              <p className="home-wall-sub">
                Post a drawing or animation for everyone to see. No follower counts, no popularity contest—just art.
              </p>
            </div>
            <div className="home-wall-actions">
              <button type="button" className="primary-action" onClick={() => onNavigate("/wall")}>
                Explore the Wall →
              </button>
              <button type="button" className="home-wall-make" onClick={() => onNavigate("/studio")}>
                Make something
              </button>
            </div>
          </div>

          {wallPosts.length > 0 ? (
            <button
              type="button"
              className="home-wall-strip"
              onClick={() => onNavigate("/wall")}
              aria-label="Open the Fridge Wall"
            >
              {wallPosts.map((p) => (
                <span className="home-wall-tile" key={p.id}>
                  {/* Eager: only a handful of small thumbs, and the whole point
                      of the strip is to be seen the moment you scroll to it. */}
                  <img src={`/api/wall/${p.id}/frame/0`} alt={p.title} />
                  {p.frames > 1 ? <span className="home-wall-anim" aria-hidden="true">🎬</span> : null}
                </span>
              ))}
              <span className="home-wall-more">
                See more<br />on the Wall →
              </span>
            </button>
          ) : wallLoaded ? (
            <div className="home-wall-empty">
              <span className="home-wall-empty-emoji" aria-hidden="true">🖼️</span>
              <p>The wall is empty — be the first to pin your artwork!</p>
              <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>
                Start drawing 🖌️
              </button>
            </div>
          ) : null}
        </section>

        <section className="home-room-directory" aria-labelledby="home-room-directory-title">
          <div className="home-room-directory-inner">
            <div className="home-room-directory-head">
              <div>
                <p className="eyebrow">Find your next canvas</p>
                <h2 id="home-room-directory-title">
                  Live rooms <span>{rooms.length}</span>
                </h2>
              </div>
              <input
                className="home-room-search"
                type="search"
                value={query}
                placeholder="Search rooms or prompts…"
                aria-label="Search open rooms"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            {rooms.length === 0 ? <p className="home-room-directory-empty">Finding open rooms…</p> : null}
            {rooms.length > 0 && filtered.length === 0 ? (
              <p className="home-room-directory-empty">No rooms match that search.</p>
            ) : null}

            <div className="home-room-grid">
              {filtered.map((room) => {
                const theme = resolvePreviewTheme({
                  roomId: room.code,
                  roomTitle: room.title,
                  roomPrompt: room.prompt,
                });
                const activity = roomActivity(room);
                const watching = room.code === activeCode;
                return (
                  <button
                    type="button"
                    key={room.code}
                    className={`home-room-card${watching ? " is-active" : ""}`}
                    aria-label={`${room.title || room.code}: ${activity}, ${room.ops || 0} marks`}
                    onClick={() => {
                      setActiveCode(room.code);
                      setJoinRoom(room);
                      setShowJoin(true);
                    }}
                  >
                    <span className={`home-room-thumb room-tone-${roomTone(room.code)}${theme ? " has-image" : ""}`}>
                      {theme ? <img src={theme.asset} alt="" loading="lazy" /> : null}
                      <span className="home-room-thumb-squiggle is-one" aria-hidden="true">~~~~</span>
                      <span className="home-room-thumb-squiggle is-two" aria-hidden="true">~~~</span>
                      <span className="home-room-card-emoji" aria-hidden="true">{room.emoji || "🎨"}</span>
                      <span className={`home-room-card-status${room.users > 0 ? " is-live" : ""}`}>
                        <i aria-hidden="true" />
                        {watching ? "On screen" : room.users > 0 ? "Live" : "Open"}
                      </span>
                    </span>
                    <span className="home-room-card-body">
                      <span className="home-room-card-title">
                        <strong>{room.title || room.code}</strong>
                        <small>{room.code}</small>
                      </span>
                      <span className="home-room-card-prompt">{room.prompt || "Free draw"}</span>
                      <span className="home-room-card-meta">
                        <span>{activity}</span>
                        <span>{compactNumber.format(room.ops || 0)} marks</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </section>
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
              {session ? (
                <button type="button" className="primary-action" onClick={() => join(joinRoom.code)}>
                  🎨 Jump in and paint
                </button>
              ) : (
                <>
                  <button type="button" className="primary-action" onClick={() => join(joinRoom.code)}>
                    Continue as guest →
                  </button>
                  <div className="home-join-auth">
                    <button type="button" onClick={() => onNavigate("/signup?mode=login")}>Log in</button>
                    <button type="button" onClick={() => onNavigate("/signup")}>Sign up free</button>
                  </div>
                </>
              )}
            </div>
            {session ? null : (
              <p className="home-join-note">No account needed to draw — sign up only to save your gallery.</p>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
