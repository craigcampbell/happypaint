import { useCallback, useEffect, useState } from "react";

const KEY_STORAGE = "drawesome:adminkey:v1";

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
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

  const checkKey = useCallback(async (key) => {
    try {
      const res = await fetch("/api/admin/check", { headers: { "x-admin-key": key }, cache: "no-store" });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!adminKey) return;
    try {
      const [r1, r2] = await Promise.all([
        fetch("/api/admin/rooms", { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
        fetch("/api/admin/reports", { headers: { "x-admin-key": adminKey }, cache: "no-store" }),
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
    } catch {
      // leave as-is on a transient error
    }
  }, [adminKey]);

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
      setError("That key didn't work — check .admin-key on the server.");
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
          <p>Enter the admin key (printed on the server console and saved in <code>.admin-key</code>).</p>
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
                  <span className="admin-muted">· {room.users} painting · {room.strokes} strokes</span>
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
