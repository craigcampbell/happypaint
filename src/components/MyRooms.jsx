// "My rooms", pick up where you left off. A signed-in person's own rooms,
// most recently touched first: rooms they own or co-host and rooms they've
// painted in, each with its picture, whether anyone is there right now, and
// their OWN last chat line there (never anyone else's words). Server:
// GET /api/me/rooms (server.js myRoomsFor). Signed out, or if the server
// can't answer, it falls back to this device's recent rooms.
//
// Two layouts: "grid" (the /rooms page) and "list" (the studio's Rooms modal).

import { useEffect, useMemo, useState } from "react";
import { getRecentRooms } from "../utils/recentRooms";

const THUMBS_MAX = 12; // each card picture is its own authed fetch

function ago(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fadesIn(ms) {
  if (ms == null || ms > 7 * 86400_000) return "";
  const days = Math.floor(ms / 86400_000);
  if (days >= 1) return `Fades in ${days}d, draw to keep it`;
  return `Fades in ${Math.max(1, Math.floor(ms / 3600_000))}h, draw to keep it`;
}

export default function MyRooms({ token = null, currentRoom = null, onJoin, variant = "grid" }) {
  const [remote, setRemote] = useState(null); // null = loading; { rooms } | { error }
  const [thumbs, setThumbs] = useState({}); // code -> object URL
  const local = useMemo(() => getRecentRooms(), []);

  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    fetch("/api/me/rooms", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => alive && setRemote({ rooms: Array.isArray(data.rooms) ? data.rooms : [] }))
      .catch(() => alive && setRemote({ error: true }));
    return () => {
      alive = false;
    };
  }, [token]);

  // Card pictures: authed fetches → object URLs, one at a time (a grid is a
  // dozen requests; no need to fire them all at once). Revoked on unmount.
  useEffect(() => {
    const list = remote && !remote.error ? remote.rooms.filter((r) => r.thumb).slice(0, THUMBS_MAX) : [];
    if (!token || !list.length) return undefined;
    let alive = true;
    const urls = [];
    (async () => {
      for (const room of list) {
        if (!alive) break;
        try {
          const res = await fetch(`/api/me/rooms/${encodeURIComponent(room.code)}/thumb`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) continue;
          const url = URL.createObjectURL(await res.blob());
          urls.push(url);
          if (alive) setThumbs((current) => ({ ...current, [room.code]: url }));
        } catch { /* a missing picture just shows the emoji */ }
      }
    })();
    return () => {
      alive = false;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [remote, token]);

  const fromServer = Boolean(token && remote && !remote.error);
  const loading = Boolean(token && remote === null);
  const rooms = fromServer
    ? remote.rooms
    : local.map((r) => ({ code: r.code, title: r.title || null, lastVisit: r.ts || null, local: true }));

  if (loading) {
    return <p className="account-note">Finding your rooms…</p>;
  }
  if (!rooms.length) {
    return (
      <p className="account-note">
        {token
          ? "No rooms yet, jump into a public room or start your own below, and it'll show up here."
          : "Rooms you visit will show up here."}
      </p>
    );
  }

  return (
    <ul className={variant === "list" ? "myrooms-list" : "myrooms-grid"}>
      {rooms.map((room) => {
        const here = room.code === currentRoom;
        const status = room.users > 0
          ? `🟢 ${room.users} here now`
          : room.lastVisit
            ? `You were here ${ago(room.lastVisit)}`
            : room.lastActivity
              ? `Active ${ago(room.lastActivity)}`
              : `Room ${room.code}`;
        const chat = room.myLastChat;
        const fade = room.private ? fadesIn(room.expiresInMs) : "";
        return (
          <li key={room.code} className={`myroom${here ? " is-here" : ""}${room.users > 0 ? " is-live" : ""}`}>
            <span className="myroom-thumb" aria-hidden="true">
              {thumbs[room.code] ? <img src={thumbs[room.code]} alt="" /> : <span>{room.emoji || (room.private ? "🔒" : "🎨")}</span>}
            </span>
            <span className="myroom-body">
              <span className="myroom-title">{room.title || `Room ${room.code}`}</span>
              {room.local ? null : (
                <span className="myroom-badges">
                  <span>{room.private ? "🔒 Private" : "🌍 Public"}</span>
                  {room.role === "owner" ? <span>👑 Yours</span> : room.role === "cohost" ? <span>⭐ Co-host</span> : null}
                  {room.animation ? <span>🎬 Film</span> : null}
                  <span className="myroom-code">{room.code}</span>
                </span>
              )}
              <span className="myroom-meta">{here ? "You're here now" : status}</span>
              {chat ? (
                <span className="myroom-chat" title={chat.message || "a doodle"}>
                  💬 You: {chat.message ? `“${chat.message}”` : "a doodle"} · {ago(chat.ts)}
                </span>
              ) : null}
              {fade ? <span className="myroom-fade">⏳ {fade}</span> : null}
            </span>
            <button type="button" className="myroom-go" disabled={here} onClick={() => onJoin(room.code)}>
              {here ? "Here" : "Continue →"}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
