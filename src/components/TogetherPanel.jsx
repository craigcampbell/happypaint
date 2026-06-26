import { useEffect, useMemo, useState } from "react";
import {
  createInviteCode,
  createInviteLink,
  normalizeInviteCode,
  readSocialSessions,
  roomAudiencePolicies,
  roomPolicyFor,
  safeMediaLibrary,
  shareInvite,
  writeSocialSessions,
} from "../utils/social";

function nextSessionTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(0, 0, 0);
  return date.toISOString().slice(0, 16);
}

export default function TogetherPanel({ initialJoinCode = "", onStatus }) {
  const [activeCode, setActiveCode] = useState(() => normalizeInviteCode(initialJoinCode) || createInviteCode());
  const [joinCode, setJoinCode] = useState(() => normalizeInviteCode(initialJoinCode));
  const [sessionTime, setSessionTime] = useState(nextSessionTime);
  const [theme, setTheme] = useState("Free draw");
  const [roomAudience, setRoomAudience] = useState("kid-safe");
  const [artistSlots, setArtistSlots] = useState(4);
  const [viewerSlots, setViewerSlots] = useState(20);
  const [sessions, setSessions] = useState(() => readSocialSessions());

  const inviteLink = useMemo(() => createInviteLink(activeCode), [activeCode]);
  const activePolicy = roomPolicyFor(roomAudience);

  useEffect(() => {
    const code = normalizeInviteCode(initialJoinCode);

    if (code) {
      setActiveCode(code);
      setJoinCode(code);
      onStatus?.(`Ready to join ${code}`);
    }
  }, [initialJoinCode, onStatus]);

  const createRoom = () => {
    const code = createInviteCode();
    setActiveCode(code);
    setJoinCode(code);
    onStatus?.(`${activePolicy.title} room ${code} ready`);
  };

  const joinRoom = () => {
    const code = normalizeInviteCode(joinCode);

    if (!code) {
      onStatus?.("Enter a room code");
      return;
    }

    setActiveCode(code);
    setJoinCode(code);
    onStatus?.(`Joining room ${code}`);
  };

  const scheduleSession = () => {
    const session = {
      id: crypto.randomUUID(),
      code: activeCode,
      audience: roomAudience,
      theme,
      artistSlots,
      viewerSlots,
      startsAt: sessionTime,
      createdAt: new Date().toISOString(),
    };
    const nextSessions = [session, ...sessions].slice(0, 6);

    setSessions(nextSessions);
    writeSocialSessions(nextSessions);
    onStatus?.("Paint date planned");
  };

  const handleShare = async () => {
    if (roomAudience === "adult-18") {
      onStatus?.("18+ rooms require adult verification before sharing");
      return;
    }

    try {
      const message = await shareInvite({ code: activeCode, title: `Happy Paint: ${theme}` });
      onStatus?.(message);
    } catch {
      onStatus?.("Invite ready");
    }
  };

  return (
    <section className="tool-section together-panel">
      <div className="section-title-row">
        <h2>Paint Together</h2>
        <button type="button" onClick={createRoom}>
          New Room
        </button>
      </div>

      <div className="room-code-card">
        <span>Room Code</span>
        <strong>{activeCode}</strong>
        <small>
          {artistSlots} artist seats · {viewerSlots} viewer seats
        </small>
        <small>{inviteLink}</small>
        <button type="button" onClick={handleShare}>
          Share Invite
        </button>
      </div>

      <div className="room-policy-panel">
        <span>Room safety</span>
        <div className="room-policy-grid">
          {roomAudiencePolicies.map((policy) => (
            <button
              type="button"
              key={policy.id}
              className={roomAudience === policy.id ? "is-active" : ""}
              onClick={() => {
                setRoomAudience(policy.id);
                onStatus?.(`${policy.title} mode selected`);
              }}
            >
              <strong>{policy.title}</strong>
              <small>{policy.label}</small>
            </button>
          ))}
        </div>
        <p>{activePolicy.detail}</p>
      </div>

      <div className="room-role-panel">
        <span>Room roles</span>
        <div className="role-input-grid">
          <label>
            <small>Artist seats</small>
            <input
              type="number"
              min="1"
              max="24"
              value={artistSlots}
              onChange={(event) => setArtistSlots(Math.max(1, Math.min(24, Number(event.target.value) || 1)))}
            />
          </label>
          <label>
            <small>Viewer seats</small>
            <input
              type="number"
              min="0"
              max="500"
              value={viewerSlots}
              onChange={(event) => setViewerSlots(Math.max(0, Math.min(500, Number(event.target.value) || 0)))}
            />
          </label>
        </div>
        <p>Hosts approve who can draw. Viewers can preview, vote, and react without touching the canvas.</p>
      </div>

      {roomAudience === "kid-safe" ? (
        <div className="safe-library-panel">
          <span>Safe library</span>
          <div className="safe-library-list">
            {safeMediaLibrary.map((item) => (
              <button type="button" key={item.id} onClick={() => setTheme(item.title)}>
                <strong>{item.title}</strong>
                <small>{item.type}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <label className="join-code-field">
        <span>Join by code</span>
        <input
          type="text"
          inputMode="text"
          value={joinCode}
          maxLength={8}
          onChange={(event) => setJoinCode(normalizeInviteCode(event.target.value))}
          placeholder="ABC123"
        />
        <button type="button" onClick={joinRoom}>
          Join
        </button>
      </label>

      <div className="planner">
        <label>
          <span>Theme</span>
          <select value={theme} onChange={(event) => setTheme(event.target.value)}>
            <option>Free draw</option>
            <option>Color together</option>
            <option>Draw a creature</option>
            <option>Wallpaper challenge</option>
          </select>
        </label>
        <label>
          <span>When</span>
          <input type="datetime-local" value={sessionTime} onChange={(event) => setSessionTime(event.target.value)} />
        </label>
        <button type="button" className="primary-action" onClick={scheduleSession}>
          Plan Paint Date
        </button>
      </div>

      {sessions.length > 0 ? (
        <div className="planned-list">
          {sessions.map((session) => (
            <button type="button" key={session.id} onClick={() => setActiveCode(session.code)}>
              <span>{session.theme}</span>
              <small>
                {session.code} · {roomPolicyFor(session.audience).title} · {session.artistSlots || 4} artists
              </small>
            </button>
          ))}
        </div>
      ) : null}

      <p className="safety-note">
        Kid-safe rooms use the curated library first. 18+ rooms should require verified adult accounts and stay hidden from child
        profiles.
      </p>
    </section>
  );
}
