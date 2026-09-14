import { useCallback, useEffect, useRef, useState } from "react";
import LiveRoomCanvas from "./LiveRoomCanvas";

const KEY_STORAGE = "drawesome:adminkey:v1";

// One row in the stroke list. A freehand stroke arrives as many small draw ops
// that share a strokeId, so they collapse into ONE row (which is what a
// moderator wants to take down); every other op kind stands alone.
function rowKey(op) {
  if (op?.kind === "draw" && op.strokeId) return `s:${op.strokeId}`;
  return `o:${op?.opId ?? Math.random()}`;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// ms remaining -> "2d", "5h", "12m", "<1m" (the room's auto-wipe countdown).
function formatLeft(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function strokeLabel(kind) {
  switch (kind) {
    case "draw": return "brush";
    case "shape": return "shape";
    case "text": return "text";
    case "image": return "image";
    case "fill": return "fill";
    default: return kind || "op";
  }
}

const DENY_TEXT = {
  bad_key: "That admin key was rejected. Check it and try again.",
  no_room: "That room isn't live right now — nobody is in it.",
  room_closed: "This room was closed while you were watching.",
  too_many: "Too many watchers are already on this room (max 4).",
  rate_limited: "Too many failed attempts from this network. Wait a minute.",
  auth_timeout: "The watch handshake timed out. Reload to try again.",
};

// The viewer opens from the admin console's "Watch" button. Nothing here draws:
// there is no canvas tool, no chat box, no cursor — and the socket behind it is
// refused everything but a moderation action, so this is not the boundary, only
// the honest UI in front of it.
export default function RoomWatch({ roomCode = "", onNavigate }) {
  const code = String(roomCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  const [adminKey, setAdminKey] = useState(() => {
    try {
      return localStorage.getItem(KEY_STORAGE) || "";
    } catch {
      return "";
    }
  });
  const [authed, setAuthed] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [denied, setDenied] = useState("");
  const [room, setRoom] = useState(null);
  const [users, setUsers] = useState([]);
  const [chat, setChat] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [modLog, setModLog] = useState([]);
  const [tab, setTab] = useState("strokes");
  const [strokes, setStrokes] = useState([]);
  const [hiddenByMe, setHiddenByMe] = useState([]);
  const [flagging, setFlagging] = useState(false);

  const sendRef = useRef(null);
  // Ops arrive in high-frequency batches while someone draws. Accumulate in a
  // ref and flush on a slow tick instead of re-rendering per dab.
  const rowsRef = useRef(new Map());
  const dirtyRef = useRef(false);
  const namesRef = useRef(new Map());
  // Op ids this visit hid, so "Restore them" can undo the whole session's work.
  const hiddenByMeRef = useRef([]);

  const bust = (path) => `${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;

  useEffect(() => {
    if (!adminKey) {
      setAuthed(false);
      return undefined;
    }
    let alive = true;
    fetch(bust("/api/admin/check"), { headers: { "x-admin-key": adminKey }, cache: "no-store" })
      .then((r) => alive && setAuthed(r.ok))
      .catch(() => alive && setAuthed(false));
    return () => {
      alive = false;
    };
  }, [adminKey]);

  // Slow flush of the accumulated stroke rows (newest first, capped).
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const list = Array.from(rowsRef.current.values()).sort((a, b) => b.lastTs - a.lastTs).slice(0, 80);
      setStrokes(list);
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  const onOps = useCallback((ops) => {
    for (const op of ops || []) {
      if (!op || typeof op !== "object") continue;
      const key = rowKey(op);
      const prev = rowsRef.current.get(key);
      const opId = Number(op.opId);
      const row = prev || {
        key,
        userId: op.userId || "?",
        kind: op.kind || "draw",
        brush: op.settings?.brush || null,
        opIds: [],
        points: 0,
        firstTs: Date.now(),
        lastTs: Date.now(),
        done: false,
      };
      if (Number.isFinite(opId) && !row.opIds.includes(opId)) row.opIds.push(opId);
      row.points += Array.isArray(op.points) ? op.points.length : 0;
      if (op.frameId) row.frameId = op.frameId;
      row.lastTs = Date.now();
      if (op.end) row.done = true;
      rowsRef.current.set(key, row);
    }
    if (rowsRef.current.size > 400) {
      // Keep the newest 200 rows' worth of memory; the view only shows 80.
      const kept = Array.from(rowsRef.current.values()).sort((a, b) => b.lastTs - a.lastTs).slice(0, 200);
      rowsRef.current = new Map(kept.map((r) => [r.key, r]));
    }
    dirtyRef.current = true;
  }, []);

  const onSocial = useCallback((data) => {
    if (data.type === "chat") {
      setChat((prev) => [...prev, { id: `c${prev.length}-${data.ts}`, name: data.user?.name || "someone", message: data.message, ts: data.ts || Date.now(), system: !!data.system }].slice(-120));
    } else if (data.type === "chat_history") {
      setChat((data.messages || []).map((m, i) => ({ id: `h${i}`, name: m.user?.name || "someone", message: m.message, ts: m.ts, system: !!m.system })));
    } else if (data.type === "hype") {
      setAlerts((prev) => [{ id: `hype${data.ts || Date.now()}`, level: "info", text: `🙌 ${data.user?.name || "someone"} hyped the canvas`, ts: Date.now() }, ...prev].slice(0, 60));
    }
  }, []);

  const onModState = useCallback((partial) => {
    if (partial.room) setRoom((prev) => ({ ...prev, ...partial.room }));
    if (partial.users) {
      setUsers(partial.users);
      setRoom((prev) => ({ ...prev, painterCount: partial.users.length }));
    }
    if (partial.modLog) setModLog(partial.modLog);
    if (partial.roomState) setRoom((prev) => ({ ...prev, locked: !!partial.roomState.locked }));
    if (partial.alert) {
      const a = partial.alert;
      setAlerts((prev) => [{
        id: `a${a.ts || Date.now()}-${prev.length}`,
        level: a.level === "warn" ? "warn" : "info",
        text: `${a.source === "auto" ? "Auto-mod" : "Flag"}: ${a.reason || "content flagged"}${a.author ? ` — ${a.author}` : ""}`,
        opIds: Array.isArray(a.opIds) ? a.opIds : null,
        ts: Date.now(),
      }, ...prev].slice(0, 60));
    }
  }, []);

  const onSend = useCallback((fn) => {
    sendRef.current = fn;
  }, []);

  const onDenied = useCallback((reason) => {
    setDenied(reason || "denied");
  }, []);

  const send = (message) => sendRef.current?.(message);

  // Names resolve as the roster and the ops arrive; the canvas also tells us what
  // it replayed, so keep a userId -> name map for attribution.
  useEffect(() => {
    users.forEach((u) => namesRef.current.set(u.id, u.name));
  }, [users]);

  const nameOf = (userId) => namesRef.current.get(userId) || (userId === "admin" ? "a moderator" : userId || "?");

  const login = async () => {
    const key = keyInput.trim();
    if (!key) return;
    try {
      const res = await fetch(bust("/api/admin/check"), { headers: { "x-admin-key": key }, cache: "no-store" });
      if (res.ok) {
        try {
          localStorage.setItem(KEY_STORAGE, key);
        } catch {
          // ephemeral if storage is blocked
        }
        setAdminKey(key);
        setAuthed(true);
        setAuthError("");
      } else {
        setAuthError("That key didn't work. Double-check it and try again.");
      }
    } catch {
      setAuthError("Couldn't reach the server. Try again.");
    }
  };

  const wipe = () => {
    if (!window.confirm(`Wipe room ${code} for everyone in it? They keep it on their screen until it clears (and you can undo it).`)) return;
    send({ type: "clear" });
  };

  const flagAndHide = async (row, reason) => {
    setFlagging(true);
    const opIds = row.opIds;
    try {
      await fetch(`/api/admin/rooms/${encodeURIComponent(code)}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ reason, opIds }),
      });
    } catch {
      // the takedown below still stands; the report is the nice-to-have
    }
    hiddenByMeRef.current = [...hiddenByMeRef.current, ...opIds];
    setHiddenByMe(hiddenByMeRef.current);
    send({ type: "mod_hide", opIds });
    setFlagging(false);
  };

  const isHostUser = (u) => !!u?.isHost;
  const hiddenSet = new Set(hiddenByMe);
  const rowHidden = (row) => row.opIds.length > 0 && row.opIds.every((id) => hiddenSet.has(id));
  const live = room?.painterCount ?? users.length;

  const header = (
    <header className="watch-top">
      <div className="watch-title">
        <h1>🕵️ Watching {code || "—"}</h1>
        <span className="watch-ghost">Invisible — nobody in this room can see you</span>
        {room?.roomTitle ? <span className="admin-muted">{room.roomTitle}</span> : null}
      </div>
      <div className="watch-status">
        <span className={`watch-dot ${denied ? "is-bad" : "is-ok"}`} aria-hidden="true" />
        <span>{denied ? "disconnected" : `${live} in the room`}</span>
        {room?.moderated ? <span className="admin-badge">kid-safe</span> : null}
        {room?.locked ? <span className="admin-badge">locked</span> : null}
        {room?.animation ? <span className="admin-badge">film room · scene 1</span> : null}
        {room?.wipe?.wipeAt ? <span className="admin-badge">auto-wipe in {formatLeft(room.wipe.wipeAt - Date.now())}</span> : null}
      </div>
      <div className="admin-top-actions">
        <button type="button" className="admin-danger" onClick={wipe}>🧹 Wipe room</button>
        <button type="button" onClick={() => send({ type: "undo_clear" })}>↩︎ Undo wipe</button>
        <button type="button" onClick={() => send({ type: room?.locked ? "unlock" : "lock" })}>
          {room?.locked ? "🔓 Unlock room" : "🔒 Lock room"}
        </button>
        <button type="button" onClick={() => onNavigate?.("/admin")}>← Console</button>
      </div>
    </header>
  );

  if (!authed) {
    return (
      <main className="admin-login">
        <div className="admin-login-card">
          <h1>🕵️ Watch a room</h1>
          <p>
            Enter your admin key to open {code ? <strong>{code}</strong> : "the room"} as an invisible
            observer. You won&apos;t be listed, counted, or announced — and this view can&apos;t draw or chat.
          </p>
          <input
            type="password"
            value={keyInput}
            placeholder="admin key"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
          {authError ? <p className="admin-error">{authError}</p> : null}
          <div className="admin-login-actions">
            <button type="button" onClick={() => onNavigate?.("/admin")}>← Console</button>
            <button type="button" className="primary-action" onClick={login}>Watch</button>
          </div>
        </div>
      </main>
    );
  }

  if (denied) {
    return (
      <main className="admin-portal">
        {header}
        <section className="admin-section">
          <h2>Can&apos;t watch this room</h2>
          <p className="admin-empty">{DENY_TEXT[denied] || `The watch connection was refused (${denied}).`}</p>
          <div className="admin-actions">
            <button type="button" onClick={() => window.location.reload()}>Try again</button>
            <button type="button" className="primary-action" onClick={() => onNavigate?.("/admin")}>Back to the console</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="admin-portal watch-portal">
      {header}

      <div className="watch-banner">
        👻 <strong>Observer mode.</strong> Drawing, chat and cursors are disabled here — you can watch the
        canvas, read the chat, and take moderation actions. The room sees “a moderator” act, never you.
      </div>

      <div className="watch-split">
        <section className="watch-canvas">
          <LiveRoomCanvas
            roomCode={code}
            modKey={adminKey}
            onOps={onOps}
            onSocial={onSocial}
            onModState={onModState}
            onSend={onSend}
            onDenied={onDenied}
          />
        </section>

        <aside className="watch-panel">
          <nav className="watch-tabs" aria-label="Watch panels">
            <button type="button" className={tab === "strokes" ? "is-active" : ""} onClick={() => setTab("strokes")}>
              Strokes <span className="admin-badge">{strokes.length}</span>
            </button>
            <button type="button" className={tab === "chat" ? "is-active" : ""} onClick={() => setTab("chat")}>
              Chat <span className="admin-badge">{chat.length}</span>
            </button>
            <button type="button" className={tab === "people" ? "is-active" : ""} onClick={() => setTab("people")}>
              People <span className="admin-badge">{users.length}</span>
            </button>
            <button type="button" className={tab === "log" ? "is-active" : ""} onClick={() => setTab("log")}>
              Log <span className="admin-badge">{alerts.length + modLog.length}</span>
            </button>
          </nav>

          {tab === "strokes" ? (
            <div className="watch-list">
              {hiddenByMe.length ? (
                <div className="watch-row">
                  <span className="admin-muted">You hid {hiddenByMe.length} op{hiddenByMe.length === 1 ? "" : "s"} on this visit.</span>
                  <button
                    type="button"
                    onClick={() => { send({ type: "mod_restore", opIds: hiddenByMe }); setHiddenByMe([]); }}
                  >
                    ↩︎ Restore them
                  </button>
                </div>
              ) : null}
              {strokes.length === 0 ? (
                <p className="admin-empty">No paint yet — anything drawn will show up here, grouped by artist.</p>
              ) : strokes.map((row) => (
                <div key={row.key} className="watch-row">
                  <span className="watch-row-main">
                    <strong>{nameOf(row.userId)}</strong>
                    <small>
                      {strokeLabel(row.kind)}{row.brush ? ` · ${row.brush}` : ""} · {row.points} pts · {row.done ? timeAgo(row.lastTs) : "drawing…"}
                    </small>
                  </span>
                  <span className="watch-row-actions">
                    {rowHidden(row) ? (
                      <>
                        <em className="watch-hidden-tag">hidden</em>
                        <button
                          type="button"
                          onClick={() => {
                            send({ type: "mod_restore", opIds: row.opIds });
                            hiddenByMeRef.current = hiddenByMeRef.current.filter((id) => !row.opIds.includes(id));
                            setHiddenByMe(hiddenByMeRef.current);
                          }}
                        >
                          ↩︎ Restore
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="admin-danger"
                          disabled={flagging}
                          onClick={() => {
                            const reason = window.prompt("Why is this being taken down? (goes in the reports queue)") || "flagged while watching";
                            flagAndHide(row, reason);
                          }}
                        >
                          🚩 Flag &amp; hide
                        </button>
                        <button
                          type="button"
                          onClick={() => { send({ type: "mod_restore", opIds: row.opIds }); }}
                        >
                          Restore
                        </button>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {tab === "chat" ? (
            <div className="watch-list watch-chat">
              {chat.length === 0 ? (
                <p className="admin-empty">No chat in this room yet.</p>
              ) : chat.map((line) => (
                <p key={line.id} className={line.system ? "is-system" : ""}>
                  <strong>{line.name}:</strong> {line.message}
                </p>
              ))}
            </div>
          ) : null}

          {tab === "people" ? (
            <div className="watch-list">
              {users.length === 0 ? (
                <p className="admin-empty">Nobody is in this room.</p>
              ) : users.map((u) => (
                <div key={u.id} className="watch-row">
                  <span className="watch-row-main">
                    <strong style={{ color: u.color || undefined }}>{u.name}</strong>
                    <small>
                      {u.signedIn ? "signed in" : "guest"}
                      {isHostUser(u) ? " · host" : ""}
                      {u.muted ? " · muted" : ""}
                    </small>
                  </span>
                  <span className="watch-row-actions">
                    <button type="button" onClick={() => send({ type: "mute", targetId: u.id, muted: !u.muted })}>
                      {u.muted ? "Unmute" : "Mute"}
                    </button>
                    <button
                      type="button"
                      className="admin-danger"
                      onClick={() => { if (window.confirm(`Remove ${u.name} from this room?`)) send({ type: "kick", targetId: u.id }); }}
                    >
                      Remove
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {tab === "log" ? (
            <div className="watch-list">
              {alerts.map((a) => (
                <div key={a.id} className={`watch-row watch-alert is-${a.level}`}>
                  <span className="watch-row-main">
                    <strong>{a.level === "warn" ? "⚠️ " : ""}{a.text}</strong>
                    <small>{timeAgo(a.ts)}</small>
                  </span>
                  {a.opIds?.length ? (
                    <span className="watch-row-actions">
                      <button type="button" className="admin-danger" onClick={() => send({ type: "mod_hide", opIds: a.opIds })}>
                        Hide these
                      </button>
                    </span>
                  ) : null}
                </div>
              ))}
              {modLog.map((entry, i) => (
                <div key={`m${i}`} className="watch-row">
                  <span className="watch-row-main">
                    <strong>{entry.action}</strong>
                    <small>
                      {entry.by === "admin" ? "a moderator" : entry.who || "the host"}
                      {entry.detail ? ` · ${entry.detail}` : ""} · {timeAgo(entry.ts)}
                    </small>
                  </span>
                </div>
              ))}
              {alerts.length === 0 && modLog.length === 0 ? (
                <p className="admin-empty">Nothing moderated in this room recently.</p>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>
    </main>
  );
}
