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
      const [r1, r2] = await Promise.all([
        fetch(bust("/api/admin/rooms"), { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
        fetch(bust("/api/admin/reports"), { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
      ]);
      if (r1.status === 401 || r2.status === 401) {
        setAuthed(false);
        return;
      }
      const d1 = await r1.json();
      const d2 = await r2.json();
      setRooms(Array.isArray(d1.rooms) ? d1.rooms : []);
      setReports(Array.isArray(d2.reports) ? d2.reports : []);
      setAuthed(true);
      const s = await fetch(bust("/api/sheets"), { cache: "no-store" }).then((r) => r.json()).catch(() => null);
      if (s) setSheets(Array.isArray(s.sheets) ? s.sheets : []);
      const m = await fetch(bust("/api/admin/metrics"), { headers: { "x-admin-key": adminKey }, cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (m) setMetrics(m);
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

  const resolveReport = async (id) => {
    await fetch(`/api/admin/reports/${id}/resolve`, { method: "POST", headers: { "x-admin-key": adminKey } });
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
                  </span>
                </div>
                <div className="admin-actions">
                  <button type="button" onClick={() => openRoom(room.id)}>View</button>
                  <button type="button" className="admin-danger" onClick={() => clearRoom(room.id)}>Clear</button>
                </div>
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
    </main>
  );
}
