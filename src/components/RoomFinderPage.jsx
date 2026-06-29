// Room Finder: browse every open public room and jump into one. Reuses the live
// /api/rooms/public feed (featured prompt rooms first, then any active ad-hoc rooms).
import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";

export default function RoomFinderPage({ onNavigate }) {
  const [rooms, setRooms] = useState([]);
  const [code, setCode] = useState("");

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/rooms/public", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => active && Array.isArray(d?.rooms) && setRooms(d.rooms))
        .catch(() => {});
    load();
    const t = window.setInterval(load, 15000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, []);

  return (
    <div className="site-page">
      <SiteNav onNavigate={onNavigate} current="/rooms" />
      <main className="site-page-body">
        <h1>Find a room</h1>
        <p className="site-lead">Pick a room and paint with whoever shows up. New prompts every day.</p>

        <form
          className="finder-code"
          onSubmit={(e) => {
            e.preventDefault();
            const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
            if (c) onNavigate(`/join/${c}`);
          }}
        >
          <input
            type="text"
            value={code}
            maxLength={8}
            placeholder="Got a room code? Type it here"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="primary-action">Join →</button>
        </form>

        <div className="open-rooms-grid">
          {rooms.map((room) => (
            <button
              type="button"
              key={room.code}
              className="open-room-card"
              onClick={() => onNavigate(`/join/${room.code}`)}
            >
              <span className="open-room-emoji" aria-hidden="true">{room.emoji || "🎨"}</span>
              <span className="open-room-title">{room.title || `Room ${room.code}`}</span>
              {room.prompt ? <span className="open-room-prompt">“{room.prompt}”</span> : null}
              <span className="open-room-meta">
                <span className="open-room-live"><i className="live-dot" aria-hidden="true" /> Open now</span>
                <span className="open-room-count">{room.users === 0 ? "Be the first!" : `${room.users} painting`}</span>
              </span>
              <span className="open-room-go">Paint here →</span>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
