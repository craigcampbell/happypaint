// The public, read-only watch page: /live/<CODE>.
//
// A shareable window into one public room's mural. Read-only by construction: it
// renders the SAME spectator client the homepage uses (LiveRoomCanvas without a
// modKey opens /ws?room=CODE&spectate=1) and hands it nothing to send with — no
// chat box, no brushes, no admin-key field, no socket control channel. The
// server is the real boundary (it refuses non-kid_safe/unlisted rooms, caps the
// viewers, drops every inbound frame a spectator sends and answers from an
// allowlist of ops/clears/history); this file is only the honest UI in front of
// it.

import { useCallback, useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import LiveRoomCanvas from "./LiveRoomCanvas";

// A borrowed, throwaway name for the "watching as …" line: client-only, never
// sent anywhere, never persisted, fresh on every visit.
const ALIAS_ANIMALS = [
  "Quiet Fox", "Sleepy Otter", "Brave Panda", "Sunny Gecko", "Calm Puffin",
  "Curious Moose", "Tiny Narwhal", "Happy Bison", "Shy Axolotl", "Cozy Badger",
  "Swift Penguin", "Gentle Yak",
];

function makeAlias() {
  const animal = ALIAS_ANIMALS[Math.floor(Math.random() * ALIAS_ANIMALS.length)];
  return `${animal} ${10 + Math.floor(Math.random() * 90)}`;
}

// Why the server said no, in words a kid can act on (never a blank canvas).
const BLOCKED_COPY = {
  not_watchable: {
    title: "This room isn’t open to watchers",
    body: "Only public rooms can be watched live. This one is private — its code is an invitation to draw with people you know, not a window for strangers.",
  },
  room_full: {
    title: "All the watch seats are taken",
    body: "Lots of people are watching this room right now. Give it a minute and reload, or go find another room that’s live.",
  },
  offline: {
    title: "We couldn’t reach that room",
    body: "Check your connection and reload — or go find a room that’s live.",
  },
};

// Internal links stay client-side, and ctrl/cmd-click still opens a new tab.
function follow(event, href, onNavigate) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  onNavigate(href);
}

export default function PublicWatch({ roomCode = "", onNavigate }) {
  // Same normalization as the /join and /watch routes.
  const code = String(roomCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  const [alias] = useState(makeAlias);
  // checking → live → blocked. The canvas only mounts once the server has
  // confirmed the room is watchable, so a refused room shows words, not a
  // forever-blank mural.
  const [status, setStatus] = useState("checking");
  const [reason, setReason] = useState("");
  const [room, setRoom] = useState(null); // this room's row in the public lobby
  const [loaded, setLoaded] = useState(false);
  const [socketTitle, setSocketTitle] = useState("");
  const [ops, setOps] = useState(0); // ops the canvas has replayed (any art at all?)

  // Stable: LiveRoomCanvas re-runs its whole socket effect if this identity
  // changes, so a fresh arrow here would reconnect the viewer on every render.
  const onActivity = useCallback((count) => setOps(count || 0), []);

  useEffect(() => {
    if (!code) return undefined;
    let active = true;
    let probe = null;
    let done = false;
    let timer = 0;

    const finish = (next, why = "") => {
      if (done) return;
      done = true;
      if (timer) window.clearTimeout(timer);
      try {
        probe?.close();
      } catch {
        /* ignore */
      }
      if (!active) return;
      setReason(why);
      setStatus(next);
    };

    // The lobby feed doubles as the warm-up: /api/rooms/public materializes the
    // always-open prompt rooms (FEATURED_ROOMS.forEach(getRoom)), so a featured
    // room that isn't in memory yet — a freshly restarted server — still answers
    // the spectate probe below instead of reading as "not watchable".
    const load = () =>
      fetch("/api/rooms/public", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!active) return;
          const mine = Array.isArray(d?.rooms) ? d.rooms.find((x) => x.code === code) || null : null;
          setRoom(mine);
          setLoaded(true);
        })
        .catch(() => {});

    load().then(() => {
      if (!active || done) return;
      // Pre-flight: one throwaway spectate socket. LiveRoomCanvas only knows how
      // to keep retrying, so we ask the server first and answer room_blocked /
      // room_full with a friendly line instead of an empty canvas.
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      try {
        probe = new WebSocket(`${proto}//${window.location.host}/ws?room=${encodeURIComponent(code)}&spectate=1`);
      } catch {
        finish("blocked", "offline");
        return;
      }
      probe.onmessage = (event) => {
        if (typeof event.data !== "string") return; // gz history frame — not ours to parse
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "room_blocked") finish("blocked", "not_watchable");
        else if (data.type === "room_full") finish("blocked", "room_full");
        else if (data.type === "connected") {
          if (data.roomTitle) setSocketTitle(String(data.roomTitle).slice(0, 80));
          finish("live");
        }
      };
      probe.onclose = () => finish("blocked", "offline");
      probe.onerror = () => finish("blocked", "offline");
      // A slow handshake shouldn't lock a viewer out of a watchable room: after
      // six seconds let the canvas try (it reconnects on its own).
      timer = window.setTimeout(() => finish("live"), 6000);
    });

    // Keep the "who's in there" line honest while the viewer stays on the page.
    const poll = window.setInterval(load, 10000);
    return () => {
      active = false;
      done = true;
      if (timer) window.clearTimeout(timer);
      window.clearInterval(poll);
      try {
        probe?.close();
      } catch {
        /* ignore */
      }
    };
  }, [code]);

  const title = room?.title || socketTitle || `Room ${code}`;
  // The lobby only lists rooms with someone in them (plus the always-open prompt
  // rooms), so "not listed" is a real answer: nobody is painting in there.
  const painters = room ? room.users || 0 : 0;
  const nobody = loaded && painters === 0;
  const blocked = BLOCKED_COPY[reason] || BLOCKED_COPY.offline;

  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/live" />
      <main className="site-page-body">
        <h1>{title}</h1>
        <p className="site-lead" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <span
            style={{
              padding: "3px 10px",
              border: "2px solid #2d6cdf",
              borderRadius: 10,
              background: "#eef4ff",
              color: "#2d6cdf",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontWeight: 900,
              letterSpacing: "0.08em",
            }}
          >
            {code}
          </span>
          <span role="status" aria-live="polite">
            {!loaded ? "Checking who’s in…" : nobody ? "Nobody painting right now" : `${painters} painting right now`}
          </span>
        </p>

        <p style={{ margin: "0 0 14px", color: "#44535e", fontWeight: 600 }}>
          <span aria-hidden="true">👀</span> You’re watching as <strong>{alias}</strong> — no sign-in, nothing saved.
          Watching is read-only: you can’t draw or chat from here.
        </p>

        {status === "blocked" ? (
          <section
            style={{
              margin: "0 0 18px",
              padding: "18px 20px",
              borderRadius: 16,
              background: "#fff7e6",
              border: "2px solid #ffd98a",
              color: "#7a5200",
            }}
          >
            <h2 style={{ margin: "0 0 8px", fontSize: "1.15rem" }}>{blocked.title}</h2>
            <p style={{ margin: "0 0 14px", fontWeight: 600 }}>{blocked.body}</p>
            <p style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: 0 }}>
              <a className="primary-action" href={`/join/${code}`} onClick={(e) => follow(e, `/join/${code}`, onNavigate)}>
                Join and draw →
              </a>
              <a href="/rooms" onClick={(e) => follow(e, "/rooms", onNavigate)}>See who’s live →</a>
            </p>
          </section>
        ) : (
          <div
            style={{
              position: "relative",
              width: "100%",
              aspectRatio: "4 / 3",
              maxHeight: "68vh",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#ffffff",
              border: "2px solid #dfe8f2",
              borderRadius: 18,
              overflow: "hidden",
            }}
          >
            {status === "live" ? (
              <LiveRoomCanvas roomCode={code} onActivity={onActivity} />
            ) : (
              <p style={{ color: "#44535e", fontWeight: 700, margin: 0 }}>Tuning in…</p>
            )}
          </div>
        )}

        {nobody && status !== "blocked" ? (
          <section
            style={{
              margin: "16px 0 0",
              padding: "16px 18px",
              borderRadius: 16,
              background: "#f2f7ff",
              border: "2px solid #cfe0f7",
              color: "#1f2b38",
            }}
          >
            <p style={{ margin: "0 0 12px", fontWeight: 700 }}>
              {ops > 0
                ? `No one is painting in ${code} this minute — the mural below is what they made earlier. Watch it here, or be the one who brings it back to life.`
                : `The canvas in ${code} is blank — nobody has started drawing yet. You could be the first.`}
            </p>
            <p style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: 0 }}>
              <a className="primary-action" href={`/join/${code}`} onClick={(e) => follow(e, `/join/${code}`, onNavigate)}>
                Join and draw →
              </a>
              <a href="/rooms" onClick={(e) => follow(e, "/rooms", onNavigate)}>Find a busier room →</a>
            </p>
          </section>
        ) : null}

        {status !== "blocked" ? (
          <p style={{ margin: "18px 0 0", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <a className="primary-action" href={`/join/${code}`} onClick={(e) => follow(e, `/join/${code}`, onNavigate)}>
              Join and draw →
            </a>
            <a href="/rooms" onClick={(e) => follow(e, "/rooms", onNavigate)}>Browse every room →</a>
          </p>
        ) : null}

        <p style={{ margin: "14px 0 0", color: "#5b6b78", fontSize: "0.95rem" }}>
          Public rooms are open to everyone who has the link. The art shown here is what that room is painting right now.
        </p>
      </main>
    </div>
  );
}
