import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const KEY_STORAGE = "drawesome:adminkey:v1";

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// How long until an idle room is auto-deleted (null = never / occupied).
function formatLeft(ms) {
  if (ms == null) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function urlParam(name) {
  try {
    return (new URLSearchParams(window.location.search).get(name) || "").slice(0, 80);
  } catch {
    return "";
  }
}

function formatCount(value) {
  return Math.round(Number(value) || 0).toLocaleString();
}

const BAND_STYLE = {
  low: { background: "#e6f6e6", color: "#1d6b1d", label: "low" },
  watch: { background: "#fdf3d7", color: "#8a6d00", label: "watch" },
  high: { background: "#fde2e2", color: "#a01c1c", label: "high" },
};

function bandStyle(band) {
  return BAND_STYLE[band] || BAND_STYLE.low;
}

const SORTERS = {
  risk: (a, b) => (b.risk || 0) - (a.risk || 0),
  distinctRooms: (a, b) => (b.distinctRooms || 0) - (a.distinctRooms || 0),
  clears: (a, b) => (b.clears || 0) - (a.clears || 0),
  chats: (a, b) => (b.chats || 0) - (a.chats || 0),
  lastSeen: (a, b) => (b.lastSeen || 0) - (a.lastSeen || 0),
  privateRooms: (a, b) =>
    (b.privateRooms || []).filter((r) => r.owned).length - (a.privateRooms || []).filter((r) => r.owned).length ||
    (b.privateRooms || []).length - (a.privateRooms || []).length,
  sessions: (a, b) => (b.sessions || 0) - (a.sessions || 0),
};

// A block on a device/session/ip key is much weaker than one on an account
// key — say so plainly instead of letting the console overpromise.
function blockCaveat(keyKind, userKey) {
  if (keyKind === "account") return null;
  if (String(userKey).startsWith("ip:")) {
    return "Anonymous block on a shared IP — this can catch a whole school or household network, and the user can move networks to evade it.";
  }
  return "Anonymous block on a device/session key — the user can clear site data or open a private window to get a new key. Strongest when they also sign in.";
}

export default function AdminUsers({ onNavigate }) {
  const [adminKey, setAdminKey] = useState(() => {
    try {
      return localStorage.getItem(KEY_STORAGE) || "";
    } catch {
      return "";
    }
  });
  const [authed, setAuthed] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");
  const [users, setUsers] = useState([]);
  const [totals, setTotals] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  // Deep link from the Room Radar "owned by" link: /admin/users?q=pb:<profileId>
  const [query, setQuery] = useState(() => urlParam("q"));
  const [debouncedQuery, setDebouncedQuery] = useState(() => urlParam("q"));
  const [onlyPrivate, setOnlyPrivate] = useState(false);
  const [sortKey, setSortKey] = useState("risk");
  // A deep-linked user opens with their details (and private rooms) showing.
  const [expanded, setExpanded] = useState(() => (urlParam("q").startsWith("pb:") ? new Set([urlParam("q")]) : new Set()));
  // Inline block confirm: { [userKey]: { open, reason, busy, notice } }
  const [blockUi, setBlockUi] = useState({});

  // A unique query string per request defeats any stale service-worker / proxy
  // cache (a cached 401 would otherwise lock you out no matter the key).
  const bust = (path) => `${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;

  const checkKey = useCallback(async (key) => {
    try {
      const res = await fetch(bust("/api/admin/check"), { headers: { "x-admin-key": key }, cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!adminKey) return;
    try {
      // Search is server-side: ?q= filters label / userKey / lastRoom there.
      const url = `/api/admin/users-index?limit=200&q=${encodeURIComponent(debouncedQuery)}`;
      const res = await fetch(bust(url), { headers: { "x-admin-key": adminKey }, cache: "no-store" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setUsers(Array.isArray(data.users) ? data.users : []);
      setTotals(data.totals || null);
      setUpdatedAt(Date.now());
      setAuthed(true);
    } catch {
      // leave as-is on a transient error
    }
  }, [adminKey, debouncedQuery]);

  // Debounce the search box so typing doesn't hammer the endpoint.
  const queryRef = useRef(null);
  useEffect(() => {
    queryRef.current = window.setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => window.clearTimeout(queryRef.current);
  }, [query]);

  useEffect(() => {
    if (adminKey) {
      checkKey(adminKey).then((ok) => setAuthed(ok));
    }
  }, [adminKey, checkKey]);

  useEffect(() => {
    if (!authed) return undefined;
    refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [authed, refresh]);

  const login = async () => {
    const key = keyInput.trim();
    if (!key) return;
    if (await checkKey(key)) {
      try {
        localStorage.setItem(KEY_STORAGE, key);
      } catch {
        // ephemeral if storage blocked
      }
      setAdminKey(key);
      setAuthed(true);
      setError("");
    } else {
      setError("That key didn't work. Double-check it and try again.");
    }
  };

  const signOut = () => {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      // ignore
    }
    setAdminKey("");
    setAuthed(false);
    setKeyInput("");
  };

  const sortedUsers = useMemo(() => {
    const sorter = SORTERS[sortKey] || SORTERS.risk;
    const pool = onlyPrivate ? users.filter((u) => (u.privateRooms || []).length > 0) : users;
    return [...pool].sort(sorter);
  }, [users, sortKey, onlyPrivate]);

  const toggleExpanded = (userKey) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userKey)) next.delete(userKey);
      else next.add(userKey);
      return next;
    });
  };

  const setBlockUiFor = (userKey, patch) => {
    setBlockUi((prev) => ({ ...prev, [userKey]: { ...(prev[userKey] || {}), ...patch } }));
  };

  const openBlock = (userKey) => setBlockUiFor(userKey, { open: true, reason: "", notice: "" });
  const cancelBlock = (userKey) => setBlockUiFor(userKey, { open: false, reason: "", busy: false });

  const blockUser = async (user) => {
    const key = user.userKey;
    const reason = (blockUi[key]?.reason || "").trim();
    setBlockUiFor(key, { busy: true, notice: "" });
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(key)}/block`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ reason }),
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        const closed = Number(data.closed) || 0;
        setBlockUiFor(key, { open: false, busy: false, reason: "", notice: `Blocked${closed ? ` — closed ${closed} live connection${closed === 1 ? "" : "s"}` : ""}.` });
        refresh();
      } else {
        setBlockUiFor(key, { busy: false, notice: "Block failed — try again." });
      }
    } catch {
      setBlockUiFor(key, { busy: false, notice: "Block failed — network error." });
    }
  };

  const unblockUser = async (user) => {
    const key = user.userKey;
    setBlockUiFor(key, { busy: true, notice: "" });
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(key)}/unblock`, {
        method: "POST",
        headers: { "x-admin-key": adminKey },
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setBlockUiFor(key, { busy: false, notice: "Unblocked." });
        refresh();
      } else {
        setBlockUiFor(key, { busy: false, notice: "Unblock failed — try again." });
      }
    } catch {
      setBlockUiFor(key, { busy: false, notice: "Unblock failed — network error." });
    }
  };

  if (!authed) {
    return (
      <main className="admin-login">
        <div className="admin-login-card">
          <h1>🛡️ Drawesome Admin</h1>
          <p>Enter your admin key to continue.</p>
          <input
            type="password"
            value={keyInput}
            placeholder="admin key"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
          {error ? <p className="admin-error">{error}</p> : null}
          <div className="admin-login-actions">
            <button type="button" onClick={() => onNavigate("/")}>
              ← Home
            </button>
            <button type="button" className="primary-action" onClick={login}>
              Unlock
            </button>
          </div>
        </div>
      </main>
    );
  }

  const headerCell = (key, label) => (
    <button
      type="button"
      className="admin-sort-btn"
      onClick={() => setSortKey(key)}
      title={`Sort by ${label}`}
      style={{ background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer", textAlign: "left" }}
    >
      {label}
      {sortKey === key ? " ▾" : ""}
    </button>
  );

  return (
    <main className="admin-portal">
      <header className="admin-top">
        <h1>🛡️ User tracker</h1>
        <div className="admin-top-actions">
          <button type="button" onClick={() => onNavigate("/admin")}>
            ← Live admin
          </button>
          <button type="button" onClick={refresh}>
            Refresh
          </button>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="admin-section">
        <h2>
          Cross-room users{" "}
          <span className="admin-muted" style={{ fontSize: "0.8rem" }}>
            one row per person across every room · updated {updatedAt ? timeAgo(updatedAt) : "—"}
          </span>
        </h2>
        {totals ? (
          <div className="metric-grid">
            <div className="metric">
              <span className="metric-num">{formatCount(totals.users)}</span>
              <span className="metric-label">Tracked users</span>
              <span className="metric-sub">{formatCount(totals.shown)} shown</span>
            </div>
            <div className="metric">
              <span className={`metric-num ${totals.high ? "is-bad" : "is-ok"}`}>{formatCount(totals.high)}</span>
              <span className="metric-label">High risk</span>
              <span className="metric-sub">red band</span>
            </div>
            <div className="metric">
              <span className={`metric-num ${totals.watch ? "is-warn" : "is-ok"}`}>{formatCount(totals.watch)}</span>
              <span className="metric-label">On watch</span>
              <span className="metric-sub">amber band</span>
            </div>
            <div className="metric">
              <span className={`metric-num ${totals.blocked ? "is-bad" : "is-ok"}`}>{formatCount(totals.blocked)}</span>
              <span className="metric-label">Blocked</span>
              <span className="metric-sub">all rooms at once</span>
            </div>
            <div
              className="metric"
              role="button"
              tabIndex={0}
              style={{ cursor: "pointer" }}
              title="Open Room Radar filtered to private rooms"
              onClick={() => onNavigate("/admin/rooms?audience=other")}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onNavigate("/admin/rooms?audience=other");
                }
              }}
            >
              <span className="metric-num">🔒 {formatCount(totals.privateRooms)}</span>
              <span className="metric-label">Private rooms</span>
              <span className="metric-sub">{formatCount(totals.privateRoomOwners)} owning accounts · open radar →</span>
            </div>
          </div>
        ) : null}

        <div className="admin-chat-filters">
          <label>
            Search
            <input
              type="search"
              value={query}
              placeholder="name, key, last room or private room code"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={onlyPrivate} onChange={(e) => setOnlyPrivate(e.target.checked)} />
            With private rooms only
          </label>
        </div>

        {sortedUsers.length === 0 ? (
          <p className="admin-empty">No users match — or no one has painted yet.</p>
        ) : (
          <div className="admin-table">
            <div className="admin-table-row admin-table-head">
              <span>User</span>
              <span>{headerCell("risk", "Risk")}</span>
              <span>
                {headerCell("distinctRooms", "Rooms")} · {headerCell("privateRooms", "🔒")}
              </span>
              <span>{headerCell("clears", "Clears")}</span>
              <span>Strokes</span>
              <span>{headerCell("chats", "Chats")}</span>
              <span>{headerCell("sessions", "Sessions")}</span>
              <span>Last room</span>
              <span>{headerCell("lastSeen", "Last seen")}</span>
              <span />
            </div>
            {sortedUsers.map((user) => {
              const isOpen = expanded.has(user.userKey);
              const ui = blockUi[user.userKey] || {};
              const band = bandStyle(user.band);
              const caveat = blockCaveat(user.keyKind, user.userKey);
              return (
                <div key={user.userKey}>
                  <div
                    className="admin-table-row"
                    style={user.blocked ? { background: "#fdecec" } : undefined}
                  >
                    <span>
                      <strong>{user.label || user.userKey}</strong>
                      <small>
                        {user.keyKind} · {user.signedIn ? "signed in" : "anonymous"}
                      </small>
                    </span>
                    <span>
                      <strong>{Math.round(Number(user.risk) || 0)}</strong>{" "}
                      <span
                        className="admin-badge"
                        style={{ background: band.background, color: band.color }}
                      >
                        {band.label}
                      </span>
                      <small>click row for why</small>
                    </span>
                    <span>
                      {formatCount(user.distinctRooms)}
                      <small>
                        {(user.roomsRecent || []).length} recent
                        {(user.privateRooms || []).length
                          ? ` · 🔒 ${user.privateRooms.length} private${user.privateRooms.some((r) => r.owned) ? ` (${user.privateRooms.filter((r) => r.owned).length} owned)` : ""}`
                          : ""}
                      </small>
                    </span>
                    <span>{formatCount(user.clears)}</span>
                    <span>{formatCount(user.strokes)}</span>
                    <span>{formatCount(user.chats)}</span>
                    <span>
                      {formatCount(user.sessions)}
                      <small>{formatCount(user.activeSessions)} live</small>
                    </span>
                    <span>{user.lastRoom || "—"}</span>
                    <span>
                      {timeAgo(user.lastSeen)}
                      <small>{formatDuration(user.totalDurationSec)} total</small>
                    </span>
                    <span className="admin-actions">
                      <button type="button" onClick={() => toggleExpanded(user.userKey)}>
                        {isOpen ? "Hide" : "Details"}
                      </button>
                      {user.blocked ? (
                        <button type="button" className="primary-action" disabled={ui.busy} onClick={() => unblockUser(user)}>
                          {ui.busy ? "…" : "Unblock"}
                        </button>
                      ) : (
                        <button type="button" className="admin-danger" disabled={ui.busy} onClick={() => openBlock(user.userKey)}>
                          Block
                        </button>
                      )}
                    </span>
                  </div>

                  {user.blocked ? (
                    <div className="admin-table-row" style={{ background: "#fdecec" }}>
                      <span style={{ gridColumn: "1 / -1" }}>
                        <em className="admin-chat-flag">BLOCKED</em>{" "}
                        <span className="admin-reason">{user.blockReason || "(no reason given)"}</span>
                        {caveat ? <small className="admin-muted" style={{ display: "block" }}>{caveat}</small> : null}
                      </span>
                    </div>
                  ) : null}

                  {ui.notice ? (
                    <div className="admin-table-row">
                      <span style={{ gridColumn: "1 / -1" }} className="admin-muted">
                        {ui.notice}
                      </span>
                    </div>
                  ) : null}

                  {ui.open ? (
                    <div className="admin-table-row">
                      <span style={{ gridColumn: "1 / -1" }}>
                        <strong>Block {user.label || user.userKey} everywhere?</strong>{" "}
                        <span className="admin-muted">This closes any live connections in every room.</span>
                        {caveat ? <small className="admin-muted" style={{ display: "block", margin: "4px 0" }}>{caveat}</small> : null}
                        <input
                          type="text"
                          value={ui.reason || ""}
                          placeholder="reason (optional, shown to other moderators)"
                          onChange={(e) => setBlockUiFor(user.userKey, { reason: e.target.value })}
                          style={{ display: "block", width: "100%", margin: "6px 0" }}
                        />
                        <span className="admin-actions">
                          <button type="button" className="admin-danger" disabled={ui.busy} onClick={() => blockUser(user)}>
                            {ui.busy ? "Blocking…" : "Confirm block"}
                          </button>
                          <button type="button" disabled={ui.busy} onClick={() => cancelBlock(user.userKey)}>
                            Cancel
                          </button>
                        </span>
                      </span>
                    </div>
                  ) : null}

                  {isOpen ? (
                    <div className="admin-table-row">
                      <span style={{ gridColumn: "1 / -1" }}>
                        <div className="admin-panel-lite" style={{ padding: "8px 0" }}>
                          <h3>Why this risk score</h3>
                          {Array.isArray(user.reasons) && user.reasons.length ? (
                            <ul style={{ margin: "4px 0 10px", paddingLeft: 18 }}>
                              {user.reasons.map((reason, i) => (
                                <li key={i}>{reason}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="admin-muted">No risk signals recorded.</p>
                          )}

                          <h3>
                            🔒 Private rooms{" "}
                            <span className="admin-muted">
                              (invite-only rooms this {user.keyKind === "account" ? "account owns or has" : "person has"} been inside, that still exist)
                            </span>
                          </h3>
                          {Array.isArray(user.privateRooms) && user.privateRooms.length ? (
                            <div className="admin-mini-list" style={{ marginBottom: 10 }}>
                              {user.privateRooms.map((room) => {
                                const left = formatLeft(room.expiresInMs);
                                return (
                                  <div key={room.room}>
                                    <strong>
                                      {room.room}
                                      {room.title ? ` — ${room.title}` : ""}
                                      {room.owned ? " · OWNER" : room.hasOwner ? " · guest of another account" : " · no account owner"}
                                      {room.users > 0 ? ` · ${room.users} in it now` : ""}
                                    </strong>
                                    <span>
                                      {formatCount(room.strokes)} strokes · {formatCount(room.visits)} visits · active {timeAgo(room.lastActivity)}
                                      {left ? ` · auto-deletes in ${left}` : ""}
                                      {room.dormant ? " · asleep on disk" : ""}
                                    </span>
                                    <span className="admin-actions">
                                      <button type="button" onClick={() => onNavigate(`/watch/${room.room}`)}>
                                        🕵️ Watch
                                      </button>
                                      <button type="button" onClick={() => onNavigate(`/admin/rooms?q=${encodeURIComponent(room.room)}`)}>
                                        Radar
                                      </button>
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="admin-muted" style={{ margin: "4px 0 10px" }}>
                              None — no surviving private room is tied to this {user.keyKind === "account" ? "account" : "person"}.
                            </p>
                          )}

                          <h3>Rooms visited <span className="admin-muted">({formatCount(user.distinctRooms)} distinct)</span></h3>
                          {Array.isArray(user.rooms) && user.rooms.length ? (
                            <p className="admin-muted" style={{ margin: "4px 0 10px" }}>
                              {user.rooms.map((r) => `${r.room} ×${formatCount(r.visits)}`).join(" · ")}
                            </p>
                          ) : (
                            <p className="admin-muted">No room history.</p>
                          )}

                          {Array.isArray(user.roomsRecent) && user.roomsRecent.length ? (
                            <>
                              <h3>Last 30 minutes</h3>
                              <p className="admin-muted" style={{ margin: "4px 0 10px" }}>
                                {user.roomsRecent.join(" · ")}
                              </p>
                            </>
                          ) : null}

                          <h3>Recent sessions</h3>
                          {Array.isArray(user.recentSessions) && user.recentSessions.length ? (
                            <div className="admin-mini-list">
                              {user.recentSessions.map((session, i) => (
                                <div key={`${session.room}-${session.joinedAt}-${i}`}>
                                  <strong>
                                    {session.room}
                                    {session.active ? " · live now" : ""}
                                  </strong>
                                  <span>
                                    joined {timeAgo(session.joinedAt)} · {formatDuration(session.durationSec)} ·{" "}
                                    {formatCount(session.strokes)} strokes · {formatCount(session.chats)} chats
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="admin-muted">No sessions recorded yet.</p>
                          )}
                          <p className="admin-muted admin-note" style={{ marginTop: 8 }}>
                            Key <code>{user.userKey}</code> · first seen {timeAgo(user.firstSeen)} · {formatCount(user.drawOps)} draw packets ·{" "}
                            {formatCount(user.gallerySaves)} gallery saves
                          </p>
                        </div>
                      </span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        <p className="admin-muted admin-note">
          Risk is a heuristic from behaviour across every room (clears, room-hopping, moderation hits) — always read the
          reasons before acting on a score. Blocking applies to every room at once; per-room kicks from the Live admin
          only remove someone from that one room.
        </p>
      </section>
    </main>
  );
}
