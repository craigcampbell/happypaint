import { useCallback, useEffect, useState } from "react";

const KEY_STORAGE = "drawesome:adminkey:v1";

function formatUptime(s) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
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

function formatCount(value) {
  return Math.round(Number(value) || 0).toLocaleString();
}

// Green / amber / red cue for "is the server straining?" numbers.
function health(value, warn, bad) {
  if (value >= bad) return "is-bad";
  if (value >= warn) return "is-warn";
  return "is-ok";
}

export default function LiveAdmin({ onNavigate }) {
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
  const [rooms, setRooms] = useState([]);
  const [reports, setReports] = useState([]);
  const [sheets, setSheets] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [page, setPage] = useState("overview");
  const [uploading, setUploading] = useState(false);

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
      const [r1, r2, r3, r4] = await Promise.all([
        fetch(bust("/api/admin/rooms"), { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
        fetch(bust("/api/admin/reports"), { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
        fetch(bust("/api/admin/analytics"), { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
        fetch(bust("/api/admin/metrics"), { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
      ]);
      if (r1.status === 401 || r2.status === 401 || r3.status === 401 || r4.status === 401) {
        setAuthed(false);
        return;
      }
      const d1 = await r1.json();
      const d2 = await r2.json();
      const d3 = r3.ok ? await r3.json() : null;
      const d4 = r4.ok ? await r4.json() : null;
      setRooms(Array.isArray(d1.rooms) ? d1.rooms : []);
      setReports(Array.isArray(d2.reports) ? d2.reports : []);
      if (d3) setAnalytics(d3);
      if (d4) setMetrics(d4);
      setAuthed(true);
      const s = await fetch(bust("/api/sheets"), { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      if (s) setSheets(Array.isArray(s.sheets) ? s.sheets : []);
    } catch {
      // leave as-is on a transient error
    }
  }, [adminKey]);

  const uploadSheet = (file) => {
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const image = String(reader.result || "");
      const img = new Image();
      img.onload = async () => {
        const tw = 240;
        const th = Math.max(1, Math.round((240 * img.height) / img.width));
        const tc = document.createElement("canvas");
        tc.width = tw;
        tc.height = th;
        const ctx = tc.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(img, 0, 0, tw, th);
        const thumb = tc.toDataURL("image/png");
        await fetch("/api/admin/sheets", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
          body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, ""), image, thumb }),
        }).catch(() => {});
        setUploading(false);
        refresh();
      };
      img.onerror = () => setUploading(false);
      img.src = image;
    };
    reader.onerror = () => setUploading(false);
    reader.readAsDataURL(file);
  };

  const deleteSheet = async (id) => {
    await fetch(`/api/admin/sheets/${id}`, { method: "DELETE", headers: { "x-admin-key": adminKey } });
    refresh();
  };

  useEffect(() => {
    if (adminKey) {
      checkKey(adminKey).then((ok) => setAuthed(ok));
    }
  }, [adminKey, checkKey]);

  useEffect(() => {
    if (!authed) return undefined;
    refresh();
    const timer = window.setInterval(refresh, 4000);
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

  const clearRoom = async (id) => {
    if (!window.confirm(`Clear room "${id}" for everyone in it?`)) return;
    await fetch(`/api/admin/rooms/${id}/clear`, { method: "POST", headers: { "x-admin-key": adminKey } });
    refresh();
  };

  const deleteRoom = async (id) => {
    if (!window.confirm(`Permanently delete room "${id}"? Everyone in it is disconnected and the drawing is erased.`)) return;
    await fetch(`/api/admin/rooms/${id}/delete`, { method: "POST", headers: { "x-admin-key": adminKey } });
    refresh();
  };

  // ms -> a short "2d", "5h", "12m", "<1m" for the auto-close countdown.
  const formatLeft = (ms) => {
    if (ms == null) return null;
    const m = Math.round(ms / 60000);
    if (m < 1) return "<1m";
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
  };

  const resolveReport = async (id) => {
    await fetch(`/api/admin/reports/${id}/resolve`, { method: "POST", headers: { "x-admin-key": adminKey } });
    refresh();
  };

  // Take down a reported chat doodle: deletes the image server-side and pushes
  // a removal to every screen currently showing it.
  const removeDoodle = async (id) => {
    await fetch(`/api/admin/doodle/${id}/remove`, { method: "POST", headers: { "x-admin-key": adminKey } });
    refresh();
  };

  const openRoom = (id) => window.open(`/join/${id}`, "_blank", "noopener");

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

  const openReports = reports.filter((r) => r.status === "open");
  const doneReports = reports.filter((r) => r.status !== "open");
  const totals = analytics?.totals || {};
  const recentUsers = analytics?.users || [];
  const recentSessions = analytics?.sessions || [];
  const roomStats = analytics?.rooms || [];
  const brushStats = analytics?.brushes || [];
  const countryStats = analytics?.countries || [];
  const timezoneStats = analytics?.timezones || [];
  const gallerySaves = analytics?.gallerySaves || [];

  return (
    <main className="admin-portal">
      <header className="admin-top">
        <h1>🛡️ Drawesome Admin</h1>
        <div className="admin-top-actions">
          <button type="button" onClick={() => onNavigate("/studio")}>
            Open studio
          </button>
          <button type="button" onClick={refresh}>
            Refresh
          </button>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Admin pages">
        <button type="button" className={page === "overview" ? "is-active" : ""} onClick={() => setPage("overview")}>
          Overview
        </button>
        <button type="button" className={page === "users" ? "is-active" : ""} onClick={() => setPage("users")}>
          Users
        </button>
        <button type="button" className={page === "content" ? "is-active" : ""} onClick={() => setPage("content")}>
          Content
        </button>
      </nav>

      {page === "overview" ? (
        <>
      {metrics ? (
        <section className="admin-section">
          <h2>Live metrics</h2>
          <div className="metric-grid">
            <div className="metric">
              <span className="metric-num">{metrics.users.total}</span>
              <span className="metric-label">Connected</span>
              <span className="metric-sub">
                {metrics.users.active} active · {metrics.users.inactive} idle
              </span>
            </div>
            <div className="metric">
              <span className="metric-num">{metrics.peakUsers ?? 0}</span>
              <span className="metric-label">Peak online</span>
              <span className="metric-sub">{metrics.peakAt ? `record ${timeAgo(metrics.peakAt)}` : "no traffic yet"}</span>
            </div>
            <div className="metric">
              <span className="metric-num">{metrics.rooms}</span>
              <span className="metric-label">Rooms</span>
              <span className="metric-sub">{metrics.strokes.toLocaleString()} strokes</span>
            </div>
            <div className="metric">
              <span className="metric-num">
                {metrics.memory.rssMB}
                <small> MB</small>
              </span>
              <span className="metric-label">RAM (RSS)</span>
              <span className="metric-sub">
                heap {metrics.memory.heapUsedMB}/{metrics.memory.heapTotalMB} MB
              </span>
            </div>
            {typeof metrics.cpuPct === "number" ? (
              <div className="metric">
                <span className={`metric-num ${health(metrics.cpuPct, 70, 90)}`}>
                  {metrics.cpuPct}
                  <small> %</small>
                </span>
                <span className="metric-label">CPU</span>
                <span className="metric-sub">single Node thread</span>
              </div>
            ) : null}
            {metrics.loopLag ? (
              <div className="metric">
                <span className={`metric-num ${health(metrics.loopLag.meanMs, 30, 80)}`}>
                  {metrics.loopLag.meanMs}
                  <small> ms</small>
                </span>
                <span className="metric-label">Event-loop lag</span>
                <span className="metric-sub">
                  p99 {metrics.loopLag.p99Ms} · max {metrics.loopLag.maxMs} ms
                </span>
              </div>
            ) : null}
            <div className="metric">
              <span className="metric-num">{formatUptime(metrics.uptimeSec)}</span>
              <span className="metric-label">Uptime</span>
              <span className="metric-sub">{metrics.connections} sockets</span>
            </div>
            <div className="metric">
              <span className="metric-num">{metrics.reports.open}</span>
              <span className="metric-label">Open reports</span>
              <span className="metric-sub">{metrics.reports.total} total</span>
            </div>
            <div className="metric">
              <span className="metric-num">{metrics.sheets}</span>
              <span className="metric-label">Sheets</span>
              <span className="metric-sub">Node {metrics.node}</span>
            </div>
          </div>
        </section>
      ) : null}

      <section className="admin-section">
        <h2>Reports {openReports.length ? <span className="admin-badge">{openReports.length} open</span> : null}</h2>
        {openReports.length === 0 ? (
          <p className="admin-empty">No open reports. 🎉</p>
        ) : (
          <div className="admin-list">
            {openReports.map((r) => (
              <div key={r.id} className="admin-report">
                <div className="admin-report-main">
                  <strong>Room {r.room}</strong>
                  <span className="admin-muted">· by {r.reporterName} · {timeAgo(r.ts)}</span>
                  <p className="admin-reason">{r.reason || "(no reason given)"}</p>
                  {r.chatContext?.length ? (
                    <div className="admin-report-chat" aria-label="Recent chat around this report">
                      {r.chatContext.slice(-8).map((c, i) => (
                        <p key={i}>
                          <strong>{c.name}:</strong> {c.message}
                          {c.doodle ? (
                            <span className="admin-doodle">
                              {/* Snapshot rides IN the report so it's reviewable even
                                  after the live store evicts. */}
                              {c.doodleImage ? (
                                <img src={c.doodleImage} alt="reported doodle" style={{ display: "block", maxWidth: 170, borderRadius: 8, margin: "4px 0" }} />
                              ) : (
                                <em> (doodle {c.doodle} — image expired)</em>
                              )}
                              <button type="button" className="admin-danger" onClick={() => removeDoodle(c.doodle)}>
                                Remove doodle
                              </button>
                            </span>
                          ) : null}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="admin-actions">
                  <button type="button" onClick={() => openRoom(r.room)}>View room</button>
                  <button type="button" className="admin-danger" onClick={() => clearRoom(r.room)}>Clear room</button>
                  <button type="button" className="primary-action" onClick={() => resolveReport(r.id)}>Resolve</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>Active rooms <span className="admin-badge">{rooms.length}</span></h2>
        {rooms.length === 0 ? (
          <p className="admin-empty">No active rooms right now.</p>
        ) : (
          <div className="admin-list">
            {rooms.map((room) => (
              <div key={room.id} className="admin-room">
                <div className="admin-report-main">
                  <strong>Room {room.id}</strong>
                  <span className="admin-muted">
                    · {room.users} painting · {room.strokes} strokes · active {timeAgo(room.lastActivity)}
                    {room.expiresInMs != null ? ` · auto-closes in ${formatLeft(room.expiresInMs)}` : ""}
                  </span>
                </div>
                <div className="admin-actions">
                  <button type="button" onClick={() => openRoom(room.id)}>View</button>
                  <button type="button" className="admin-danger" onClick={() => clearRoom(room.id)}>Clear</button>
                  <button type="button" className="admin-danger" onClick={() => deleteRoom(room.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

        </>
      ) : null}

      {page === "users" ? (
        <>
          <section className="admin-section">
            <h2>User analytics</h2>
            {!analytics ? (
              <p className="admin-empty">Waiting for traffic to build the analytics view.</p>
            ) : (
              <div className="metric-grid">
                <div className="metric">
                  <span className="metric-num">{formatCount(totals.activeSessions)}</span>
                  <span className="metric-label">Active sessions</span>
                  <span className="metric-sub">{formatCount(totals.sessions)} recorded</span>
                </div>
                <div className="metric">
                  <span className="metric-num">{formatCount(totals.signedInUsers)}</span>
                  <span className="metric-label">Signed-in users</span>
                  <span className="metric-sub">{formatCount(totals.signedInSessions)} sessions</span>
                </div>
                <div className="metric">
                  <span className="metric-num">{formatCount(totals.anonymousUsers)}</span>
                  <span className="metric-label">Anonymous guests</span>
                  <span className="metric-sub">{formatCount(totals.anonymousSessions)} sessions</span>
                </div>
                <div className="metric">
                  <span className="metric-num">{formatDuration(totals.avgSessionSec)}</span>
                  <span className="metric-label">Avg session</span>
                  <span className="metric-sub">completed recent sessions</span>
                </div>
                <div className="metric">
                  <span className="metric-num">{formatCount(totals.strokes)}</span>
                  <span className="metric-label">Brush uses</span>
                  <span className="metric-sub">{formatCount(totals.drawOps)} draw packets</span>
                </div>
                <div className="metric">
                  <span className="metric-num">{formatCount(totals.points)}</span>
                  <span className="metric-label">Paint points</span>
                  <span className="metric-sub">networked dab samples</span>
                </div>
              </div>
            )}
          </section>

          <section className="admin-section">
            <h2>Users <span className="admin-badge">{recentUsers.length}</span></h2>
            {recentUsers.length === 0 ? (
              <p className="admin-empty">No user sessions have been recorded yet.</p>
            ) : (
              <div className="admin-table">
                <div className="admin-table-row admin-table-head">
                  <span>User</span>
                  <span>Where</span>
                  <span>Time</span>
                  <span>Paint</span>
                </div>
                {recentUsers.map((user, i) => (
                  <div key={`${user.label}-${user.lastSeen}-${i}`} className="admin-table-row">
                    <span>
                      <strong>{user.label}</strong>
                      <small>{user.active ? "active now" : `last ${timeAgo(user.lastSeen)}`} · {user.signedIn ? "signed in" : "anonymous"}</small>
                    </span>
                    <span>
                      {user.country || user.timezone || "unknown"}
                      <small>{user.locale || user.deviceType || "unknown device"}</small>
                    </span>
                    <span>
                      {formatDuration(user.totalDurationSec)}
                      <small>{formatCount(user.sessions)} sessions · room {user.lastRoom || "?"}</small>
                    </span>
                    <span>
                      {user.topBrush || "none"}
                      <small>{formatCount(user.strokes)} uses · {formatCount(user.gallerySaves)} saves</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="admin-section">
            <h2>Recent sessions <span className="admin-badge">{recentSessions.length}</span></h2>
            {recentSessions.length === 0 ? (
              <p className="admin-empty">No session history yet.</p>
            ) : (
              <div className="admin-table">
                <div className="admin-table-row admin-table-head">
                  <span>Session</span>
                  <span>Room</span>
                  <span>Duration</span>
                  <span>Activity</span>
                </div>
                {recentSessions.map((session) => (
                  <div key={session.id} className="admin-table-row">
                    <span>
                      <strong>{session.displayName || session.account || "Anonymous"}</strong>
                      <small>{session.active ? "active now" : timeAgo(session.leftAt || session.joinedAt)} · {session.deviceType}</small>
                    </span>
                    <span>
                      {session.room}
                      <small>{session.country || session.timezone || "location unknown"}</small>
                    </span>
                    <span>
                      {formatDuration(session.durationSec)}
                      <small>joined {timeAgo(session.joinedAt)}</small>
                    </span>
                    <span>
                      {session.topBrush || "none"}
                      <small>{formatCount(session.strokes)} uses · {formatCount(session.chats)} chats</small>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="admin-section">
            <h2>Rooms and brushes</h2>
            <div className="admin-split">
              <div className="admin-panel-lite">
                <h3>Rooms</h3>
                {roomStats.length === 0 ? (
                  <p className="admin-empty">No room analytics yet.</p>
                ) : (
                  <div className="admin-mini-list">
                    {roomStats.slice(0, 12).map((room) => (
                      <div key={room.id}>
                        <strong>{room.id}</strong>
                        <span>{formatCount(room.sessions)} sessions · {formatDuration(room.totalDurationSec)} · {formatCount(room.clears)} wipes</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="admin-panel-lite">
                <h3>Brushes</h3>
                {brushStats.length === 0 ? (
                  <p className="admin-empty">No brush usage yet.</p>
                ) : (
                  <div className="admin-mini-list">
                    {brushStats.slice(0, 12).map((brush) => (
                      <div key={brush.id}>
                        <strong>{brush.id}</strong>
                        <span>{formatCount(brush.count)} uses</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="admin-panel-lite">
                <h3>Rough location</h3>
                <div className="admin-mini-list">
                  {[...countryStats.slice(0, 6), ...timezoneStats.slice(0, 6)].map((item) => (
                    <div key={item.id}>
                      <strong>{item.id}</strong>
                      <span>{formatCount(item.count)} sessions</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </>
      ) : null}

      {page === "content" ? (
        <>
          <section className="admin-section">
            <h2>Content metrics</h2>
            <div className="metric-grid">
              <div className="metric">
                <span className="metric-num">{formatCount(totals.gallerySaves)}</span>
                <span className="metric-label">Gallery saves</span>
                <span className="metric-sub">
                  {formatCount(totals.signedInGallerySaves)} signed-in · {formatCount(totals.anonymousGallerySaves)} anon
                </span>
              </div>
              <div className="metric">
                <span className="metric-num">{formatCount(totals.roomClears)}</span>
                <span className="metric-label">Room wipes</span>
                <span className="metric-sub">{formatCount(totals.adminRoomClears)} by admin</span>
              </div>
              <div className="metric">
                <span className="metric-num">{formatCount(totals.chats)}</span>
                <span className="metric-label">Chats</span>
                <span className="metric-sub">accepted messages</span>
              </div>
            </div>
          </section>

          <section className="admin-section">
            <h2>Recent gallery saves <span className="admin-badge">{gallerySaves.length}</span></h2>
            {gallerySaves.length === 0 ? (
              <p className="admin-empty">No gallery saves recorded yet.</p>
            ) : (
              <div className="admin-mini-list">
                {gallerySaves.slice(0, 30).map((save, i) => (
                  <div key={`${save.ts}-${i}`}>
                    <strong>{save.signedIn ? `Account ${save.account || ""}` : "Anonymous gallery"}</strong>
                    <span>{timeAgo(save.ts)} · {save.country || "country unknown"}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

      <section className="admin-section">
        <h2>
          Coloring sheets <span className="admin-badge">{sheets.length}</span>
        </h2>
        <label className="admin-upload">
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              uploadSheet(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <span>{uploading ? "Uploading…" : "⬆️ Upload a coloring sheet (PNG line art works best)"}</span>
        </label>
        <p className="admin-muted" style={{ margin: "6px 0 12px" }}>
          Tip: use transparent-background black-line PNGs so kids can color underneath. Generate them with any
          coloring-page maker or AI image tool, then upload here.
        </p>
        {sheets.length === 0 ? (
          <p className="admin-empty">No sheets yet.</p>
        ) : (
          <div className="admin-sheet-grid">
            {sheets.map((sheet) => (
              <div key={sheet.id} className="admin-sheet">
                {sheet.thumb ? <img src={sheet.thumb} alt={sheet.name} /> : <span className="sheet-noimg">🎨</span>}
                <span className="admin-sheet-name">{sheet.name}</span>
                <button type="button" className="admin-danger" onClick={() => deleteSheet(sheet.id)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {doneReports.length > 0 ? (
        <section className="admin-section">
          <h2>Resolved</h2>
          <div className="admin-list admin-resolved">
            {doneReports.slice(0, 20).map((r) => (
              <div key={r.id} className="admin-report is-done">
                <span><strong>Room {r.room}</strong> · {r.reason || "(no reason)"} · {timeAgo(r.ts)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
        </>
      ) : null}
    </main>
  );
}
