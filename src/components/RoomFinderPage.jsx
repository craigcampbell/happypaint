// Room Finder: browse every open public room and jump into one. Reuses the live
// /api/rooms/public feed (featured prompt rooms first, then any active ad-hoc rooms).
// Signed in, it opens with YOUR rooms first ("pick up where you left off") -
// logging in lands here, so a returning artist is one tap from their work.
import { useEffect, useState } from "react";
import SiteNav from "./SiteNav";
import SiteFooter from "./SiteFooter";
import { QUICK_JOIN_PATH } from "../data/curatorContent";
import MyRooms from "./MyRooms";
import { getSession, onAuthStateChange } from "../utils/auth";
import { getRecentRooms } from "../utils/recentRooms";

export default function RoomFinderPage({ onNavigate }) {
  const [rooms, setRooms] = useState(null);
  const [listError, setListError] = useState(false);
  const [code, setCode] = useState("");
  const [session, setSession] = useState(null);
  const [hasRecent] = useState(() => getRecentRooms().length > 0);

  useEffect(() => {
    let active = true;
    getSession().then((value) => active && setSession(value));
    const unsubscribe = onAuthStateChange((value) => active && setSession(value));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/rooms/public", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!Array.isArray(data?.rooms)) throw new Error('rooms_unavailable');
          if (active) { setRooms(data.rooms); setListError(false); }
        })
        .catch(() => { if (active) setListError(true); });
    load();
    const t = window.setInterval(load, 15000);
    return () => {
      active = false;
      window.clearInterval(t);
    };
  }, []);

  // "Where are the people?", the feed already carries live counts, but a flat
  // grid of 20 identical "Be the first!" cards answers that question with a
  // shrug. Busy rooms rise to the top, cards with someone in them get a hot
  // highlight, and when nobody is anywhere we say so once instead of 20 times.
  const ordered = [...(rooms || [])].sort(
    (a, b) => (b.users || 0) - (a.users || 0) || (b.ops || 0) - (a.ops || 0),
  );
  const anyLive = ordered.some((r) => (r.users || 0) > 0);

  return (
    <div className="site-page room-directory">
      <SiteNav onNavigate={onNavigate} current="/rooms" />
      <main className="site-page-body">
        <header className="directory-heading">
          <h1>Public drawing rooms</h1>
          <p className="site-lead">Pick a shared canvas by theme or let us find a room with people painting. Use a room code to meet someone you already know.</p>
          <a className="directory-shuffle" href={QUICK_JOIN_PATH}>Join an Art Jam</a>
        </header>

        {session || hasRecent ? (
          <section className="myrooms-section" aria-labelledby="myrooms-title">
            <h2 id="myrooms-title">{session ? "Pick up where you left off" : "Your recent rooms"}</h2>
            <MyRooms variant="grid" token={session?.access_token || null} onJoin={(c) => onNavigate(`/join/${c}`)} />
          </section>
        ) : null}

        <form
          className="finder-code"
          onSubmit={(e) => {
            e.preventDefault();
            const c = code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
            if (c) onNavigate(`/join/${c}`);
          }}
        >
          <label htmlFor="directory-room-code">Have a room code?</label>
          <input id="directory-room-code"
            type="text"
            value={code}
            maxLength={8}
            placeholder="Room code" autoComplete="off" spellCheck={false}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button type="submit" className="primary-action" disabled={!code.trim()}>Join room</button>
        </form>

        <h2 className="directory-list-title">Browse by theme</h2>
        {listError ? <p role="status">Room counts are unavailable. The list will refresh automatically. You can still join the <a href="/join/MAIN">Open Studio</a>.</p>
          : !rooms ? <p role="status">Checking the room list…</p>
          : !rooms.length ? <p>No rooms are listed right now. <a href="/draw">Open a solo canvas</a>.</p>
          : !anyLive && <p className="directory-quiet">The rooms are quiet. Pick one to start a drawing that the next visitor can add to.</p>}

        <div className="directory-grid">
          {ordered.map(room => <a key={room.code} className="directory-room" href={'/join/' + room.code}>
            <span className="directory-room-symbol" aria-hidden="true">{room.emoji || '🎨'}</span>
            <div><h3>{room.title || room.code}</h3>
              {room.prompt && <p>{room.prompt}</p>}
              <small>{room.users ? room.users + ' painting' : 'Open canvas'} · {room.code}</small>
            </div>
          </a>)}
        </div>
      </main>
      <SiteFooter onNavigate={onNavigate} />
    </div>
  );
}
