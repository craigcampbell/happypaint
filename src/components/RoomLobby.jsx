// Room lobby — browse the live public (kid_safe) drawing rooms and hop between
// them, or spin up a new room. Public rooms are discoverable and moderated;
// private rooms are invite-only. Creating a public room needs a signed-in
// grown-up to own/host it (the server enforces this); private rooms are open to
// anyone. Reachable from the studio chat bar.

import { useCallback, useEffect, useState } from "react";

export default function RoomLobby({ token, signedIn, currentRoom, onJoin, onClose, onToast }) {
  const [rooms, setRooms] = useState(null); // null = loading
  const [error, setError] = useState(false);
  const [title, setTitle] = useState("");
  const [makePublic, setMakePublic] = useState(Boolean(signedIn));
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/rooms/public", { cache: "no-store" });
      const data = await res.json();
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
    } catch {
      setError(true);
      setRooms([]);
    }
  }, []);

  useEffect(() => {
    load();
    // Light auto-refresh while the lobby is open so headcounts stay live.
    const t = window.setInterval(load, 8000);
    return () => window.clearInterval(t);
  }, [load]);

  const create = useCallback(async () => {
    if (creating) return;
    const audience = makePublic ? "kid_safe" : "friends";
    if (makePublic && !signedIn) {
      onToast?.("Sign in to host a public room");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ audience, title: title.trim(), listed: true }),
      });
      if (res.status === 401) {
        onToast?.("Sign in to host a public room");
        setCreating(false);
        return;
      }
      if (!res.ok) {
        onToast?.("Couldn't make the room — please try again");
        setCreating(false);
        return;
      }
      const data = await res.json();
      if (data.code) {
        onJoin(data.code);
        return; // navigating away
      }
      onToast?.("Couldn't make the room — please try again");
    } catch {
      onToast?.("Couldn't make the room — please try again");
    }
    setCreating(false);
  }, [creating, makePublic, signedIn, token, title, onJoin, onToast]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal lobby-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lobby-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="lobby-title">🌐 Drawing rooms</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="ps-group lobby-section">
          <h3>Public rooms</h3>
          {rooms === null ? (
            <p className="account-note">Looking for rooms…</p>
          ) : rooms.length === 0 ? (
            <p className="account-note">
              {error ? "Couldn't load rooms right now." : "No public rooms are open yet — start one below!"}
            </p>
          ) : (
            <ul className="lobby-room-list">
              {rooms.map((room) => {
                const here = room.code === currentRoom;
                return (
                  <li key={room.code} className="lobby-room">
                    <span className="lobby-room-main">
                      <span className="lobby-room-name">{room.title || `Room ${room.code}`}</span>
                      <span className="lobby-room-meta">
                        {room.users} painting{room.hasHost ? " · hosted" : ""}
                        {here ? " · you're here" : ""}
                      </span>
                    </span>
                    <button type="button" disabled={here} onClick={() => onJoin(room.code)}>
                      {here ? "Here" : "Join"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button type="button" className="lobby-refresh" onClick={load}>
            ↻ Refresh
          </button>
        </div>

        <div className="ps-group lobby-section">
          <h3>Start a new room</h3>
          <label className="color-picker">
            <span>Room name (optional)</span>
            <input
              type="text"
              value={title}
              maxLength={40}
              placeholder="e.g. Dragon Doodles"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
          </label>
          <div className="lobby-audience">
            <button
              type="button"
              className={makePublic ? "lobby-aud-on" : ""}
              onClick={() => setMakePublic(true)}
              aria-pressed={makePublic}
            >
              🌐 Public
              <small>Anyone can find &amp; join. Moderated. Needs sign-in.</small>
            </button>
            <button
              type="button"
              className={!makePublic ? "lobby-aud-on" : ""}
              onClick={() => setMakePublic(false)}
              aria-pressed={!makePublic}
            >
              🔒 Private
              <small>Invite-only. Share the link with friends.</small>
            </button>
          </div>
          {makePublic && !signedIn ? (
            <p className="account-note">Sign in to host a public room. You can still make a private one.</p>
          ) : null}
          <button type="button" className="primary-action" disabled={creating} onClick={create}>
            {creating ? "Making room…" : makePublic ? "Create public room" : "Create private room"}
          </button>
        </div>
      </section>
    </div>
  );
}
