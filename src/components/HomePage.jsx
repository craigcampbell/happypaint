// The homepage has one job: make it obvious that you can start drawing now.
// Community, rooms, and the daily prompt still have a home here, but they sit
// below the primary invitation instead of competing with it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import LiveRoomCanvas from "./LiveRoomCanvas";
import BrandMark from "./BrandMark";
import { getSession, onAuthStateChange } from "../utils/auth";
import { HYPES } from "../utils/hypes";

const normalizeCode = (raw) => (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);

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

// The room's live conversation floating over the homepage viewport — the talk
// IS the show. Owns its own state fed via listenerRef, so a chatty room only
// re-renders these few spans, never the page. Mounted keyed by room code.
// Inert spans only (it renders inside the viewer <button>).
function HomeBanter({ listenerRef }) {
  const [lines, setLines] = useState([]);
  const [hypes, setHypes] = useState([]);
  const idRef = useRef(0);
  useEffect(() => {
    listenerRef.current = (data) => {
      if (data.type === "chat") {
        setLines((cur) => [...cur.slice(-3), data]);
      } else if (data.type === "chat_history") {
        setLines(Array.isArray(data.messages) ? data.messages.slice(-3) : []);
      } else if (data.type === "hype") {
        const meta = HYPES.find((h) => h.kind === data.kind);
        if (!meta) return;
        const hid = `hh${(idRef.current += 1)}`;
        setHypes((cur) => (cur.length >= 2 ? cur : [...cur, { id: hid, kind: data.kind, emoji: meta.emoji }]));
        window.setTimeout(() => setHypes((cur) => (cur.some((h) => h.id === hid) ? cur.filter((h) => h.id !== hid) : cur)), 2400);
      }
    };
    return () => {
      if (listenerRef.current) listenerRef.current = null;
    };
  }, [listenerRef]);

  return (
    <>
      {lines.length > 0 ? (
        <span className="home-banter" aria-hidden="true">
          {lines.map((m, i) => (
            <span key={m.msgId || i} className={`home-banter-line${m.system ? " is-system" : ""}`}>
              {!m.system ? (
                <span className="home-banter-name" style={{ color: m.user?.color || "#cbd5e1" }}>{m.user?.name}</span>
              ) : null}
              <span className="home-banter-text">{m.doodle ? "🎨 sent a doodle " : ""}{m.message}</span>
            </span>
          ))}
        </span>
      ) : null}
      {hypes.length > 0 ? (
        <span className="home-banter-hypes" aria-hidden="true">
          {hypes.map((h, i) => (
            <span key={h.id} className={`hype-burst hype-${h.kind}`} style={{ "--lane": i }}>
              <span className="hype-emoji">{h.emoji}</span>
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

export default function HomePage({ onNavigate }) {
  const [rooms, setRooms] = useState([]);
  const [activeCode, setActiveCode] = useState(null);
  const [code, setCode] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const [joinRoom, setJoinRoom] = useState(null); // frozen snapshot of the room the modal is for
  const [wallPosts, setWallPosts] = useState([]); // recent Fridge Wall art
  const [wallLoaded, setWallLoaded] = useState(false);
  // The Daily Challenge: today's prompt + a countdown tick.
  const [daily, setDaily] = useState(null);
  const [, setCountTick] = useState(0); // re-render for the countdown label
  // State (not a one-shot memo) so a tab left open across midnight can refresh
  // the chip when the challenge rolls over below.
  const [streak, setStreak] = useState(readStreak);
  // The viewed room's live banter rides through a ref-listener into the
  // <HomeBanter> child, so a busy room's chat re-renders THAT tiny overlay —
  // never this whole page. onSocial itself stays referentially stable so
  // LiveRoomCanvas's socket effect (keyed on it) never reconnects.
  const socialListenerRef = useRef(null);
  const onSocial = useCallback((data) => {
    socialListenerRef.current?.(data);
  }, []);
  // Mirrored into a ref so refresh() can leave the selected room alone while
  // its join dialog is open.
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

  // Today's challenge. Refetched when the countdown crosses midnight (the tick
  // effect below re-runs this when daily.endsAt passes).
  useEffect(() => {
    let active = true;
    fetch("/api/daily", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active || !d || !d.prompt) return;
        setDaily(d);
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
          })
          .catch(() => { /* retry next tick */ });
      } else {
        setCountTick((n) => n + 1);
      }
    }, 60_000);
    return () => window.clearInterval(t);
  }, [daily]);

  const active = useMemo(() => rooms.find((r) => r.code === activeCode) || null, [rooms, activeCode]);

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
        <section className="home-hero" aria-labelledby="home-title">
          <div className="home-hero-copy">
            <p className="home-eyebrow">Free online drawing studio</p>
            <h1 id="home-title">Draw something.</h1>
            <p className="home-hero-line">Right here, right now.</p>
            <p className="home-sub">
              Open a blank canvas and start painting. No account, no setup—just draw.
            </p>
            <div className="home-hero-actions">
              <button type="button" className="primary-action home-draw-now" onClick={() => onNavigate("/studio")}>
                Start drawing <span aria-hidden="true">→</span>
              </button>
              <button type="button" className="home-together-link" onClick={startRoom}>
                Draw with friends
              </button>
            </div>
            <p className="home-reassurance">
              <span>Free</span><i aria-hidden="true" />
              <span>No account needed</span><i aria-hidden="true" />
              <span>Touch, mouse &amp; pen</span>
            </p>
          </div>

          <button
            type="button"
            className="home-paper"
            onClick={() => onNavigate("/studio")}
            aria-label="Open a blank canvas and start drawing"
          >
            <span className="home-paper-sun" aria-hidden="true" />
            <span className="home-paper-stroke home-paper-stroke-one" aria-hidden="true" />
            <span className="home-paper-stroke home-paper-stroke-two" aria-hidden="true" />
            <BrandMark className="home-paper-mark" showName={false} />
            <span className="home-paper-note">Your canvas is waiting.</span>
            <span className="home-paper-pencil" aria-hidden="true">✎</span>
          </button>
        </section>

        <p className="home-feature-line" aria-label="Things you can do in Drawesome">
          Blank canvas <span aria-hidden="true">·</span> Coloring pages <span aria-hidden="true">·</span> Shared rooms <span aria-hidden="true">·</span> Drawing games
        </p>

        <section className="home-next" aria-labelledby="home-next-title">
          <div className="home-section-heading">
            <p className="home-eyebrow">Pick a way to begin</p>
            <h2 id="home-next-title">What do you want to draw?</h2>
          </div>

          <div className="home-choice-grid">
            <button type="button" className="home-choice home-choice-blank" onClick={() => onNavigate("/studio")}>
              <span className="home-choice-icon" aria-hidden="true">✎</span>
              <span><strong>Anything you want</strong><small>Start with a fresh canvas</small></span>
              <b aria-hidden="true">→</b>
            </button>

            {daily ? (
              <button type="button" className="home-choice home-choice-daily" onClick={() => join("DAILY")}>
                <span className="home-choice-icon" aria-hidden="true">{daily.emoji}</span>
                <span>
                  <strong>{daily.prompt}</strong>
                  <small>
                    Today&rsquo;s prompt · {untilLabel(daily.endsAt)} left
                    {streak >= 2 ? ` · 🔥 ${streak} days` : ""}
                  </small>
                </span>
                <b aria-hidden="true">→</b>
              </button>
            ) : (
              <button type="button" className="home-choice home-choice-daily" onClick={() => join("DAILY")}>
                <span className="home-choice-icon" aria-hidden="true">✨</span>
                <span><strong>Today&rsquo;s prompt</strong><small>Try a quick drawing challenge</small></span>
                <b aria-hidden="true">→</b>
              </button>
            )}

            <button type="button" className="home-choice home-choice-friends" onClick={startRoom}>
              <span className="home-choice-icon" aria-hidden="true">☺</span>
              <span><strong>Something together</strong><small>Make a room and invite friends</small></span>
              <b aria-hidden="true">→</b>
            </button>
          </div>

          <form className="home-code" onSubmit={goByCode}>
            <label htmlFor="home-room-code">Already have a room code?</label>
            <span>
              <input
                id="home-room-code"
                type="text"
                value={code}
                placeholder="Enter code"
                maxLength={8}
                autoCapitalize="characters"
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
              <button type="submit">Join room →</button>
            </span>
          </form>
        </section>

        <section className="home-live" aria-labelledby="home-live-title">
          <div className="home-live-copy">
            <p className="home-eyebrow"><span className="live-dot" aria-hidden="true" /> Draw together</p>
            <h2 id="home-live-title">A canvas is better with company.</h2>
            <p>
              Paint on the same canvas in real time, or play a drawing game. Send a room code and everyone can jump in.
            </p>
            <div className="home-live-actions">
              <button type="button" className="primary-action" onClick={startRoom}>Create a room</button>
              <button type="button" onClick={() => onNavigate("/rooms")}>See live rooms</button>
            </div>
          </div>

          <div className="home-live-preview">
            <div className="home-viewer-head">
              <span className="home-viewing"><span className="live-dot" aria-hidden="true" /> Live canvas</span>
              <strong className="home-room-name">
                {active ? `${active.emoji || "🎨"} ${active.title || active.code}` : "Open drawing room"}
              </strong>
              <span className="home-room-meta">{active ? `${active.users} drawing now` : "Ready for you"}</span>
            </div>
            <button
              type="button"
              className="home-viewer"
              onClick={() => {
                if (active) {
                  setJoinRoom(active);
                  setShowJoin(true);
                } else {
                  startRoom();
                }
              }}
              aria-label={active ? `Join ${active.title || active.code}` : "Create a drawing room"}
            >
              {activeCode ? <LiveRoomCanvas roomCode={activeCode} onSocial={onSocial} /> : <span className="home-viewer-empty">Start the first drawing</span>}
              {/* keyed by room: a carousel hop remounts the overlay clean, so a
                  late chat_history from the OLD room can never bleed across. */}
              {activeCode ? <HomeBanter key={activeCode} listenerRef={socialListenerRef} /> : null}
              <span className="home-viewer-cta">{active ? "Join this canvas →" : "Create a room →"}</span>
            </button>
            {/* One tap from reading the banter to being IN it. */}
            {active ? (
              <button type="button" className="home-join-chat" onClick={() => join(active.code)}>
                <span className="home-join-chat-hint">💬 Join the chat — say hi, drop a doodle…</span>
                <span className="home-join-chat-go">Chat →</span>
              </button>
            ) : null}
          </div>
        </section>

        <section className="home-wall" aria-labelledby="home-wall-title">
          <div className="home-wall-head">
            <div className="home-wall-copy">
              <p className="home-eyebrow">Made on Drawesome</p>
              <h2 id="home-wall-title">See what people are making.</h2>
            </div>
            <button type="button" className="home-wall-link" onClick={() => onNavigate("/wall")}>Visit the Wall →</button>
          </div>

          {wallPosts.length > 0 ? (
            <button type="button" className="home-wall-strip" onClick={() => onNavigate("/wall")} aria-label="Open the Fridge Wall">
              {wallPosts.slice(0, 6).map((p) => (
                <span className="home-wall-tile" key={p.id}>
                  <img src={`/api/wall/${p.id}/frame/0`} alt={p.title} loading="lazy" decoding="async" />
                  {p.frames > 1 ? <span className="home-wall-anim" aria-hidden="true">🎬</span> : null}
                </span>
              ))}
            </button>
          ) : wallLoaded ? (
            <div className="home-wall-empty">
              <span className="home-wall-empty-emoji" aria-hidden="true">🖼️</span>
              <p>The wall is waiting for its first drawing.</p>
              <button type="button" className="primary-action" onClick={() => onNavigate("/studio")}>Make one</button>
            </div>
          ) : null}
        </section>
      </main>

      <SiteFooter onNavigate={onNavigate} />

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
