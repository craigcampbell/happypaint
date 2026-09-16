// Room Radar (/admin/rooms): the moderator's whole-estate room console. One
// admin-guarded payload (/api/admin/radar) carries every room's row — activity,
// reports summary and the chat digest — so 300+ rooms can be searched, sorted
// and filtered client-side with no per-room round-trips. Report-driven row
// highlighting is the headline feature: open reports paint a row amber, urgent
// reports paint it red, and a chat digest that needs review (but has no report)
// paints it violet.
//
// Row tint choice: the admin palette in App.css is LIGHT (white .admin-report /
// .admin-room cards, #0f172a ink), so the tints mirror the existing
// .admin-chat-row.is-blocked treatment (#fef2f2 / red border) — pale fills with
// dark slate text keep ~12:1 contrast and stay readable next to the white rows.
import { useCallback, useEffect, useMemo, useState } from "react";

const KEY_STORAGE = "drawesome:adminkey:v1";
const ROW_CAP = 150; // render cap: a 300+ room estate stays snappy without paging libs
const POLL_MS = 10000;

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function clock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ms -> a short "2d", "5h", "12m", "<1m" for the auto-close countdown.
function formatLeft(ms) {
  if (ms == null) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Chat "worth a look" score: severe filter hits + contact-sharing + concern phrases.
function concernScore(room) {
  const c = room.chat || {};
  return (c.severe || 0) + (c.contact || 0) + (c.concern || 0);
}

// Report-driven row tint (see the header comment for the palette rationale).
function rowTint(room) {
  const reports = room.reports || {};
  if (reports.urgent > 0) return { background: "#fef2f2", borderColor: "#f87171" };
  if (reports.open > 0) return { background: "#fffbeb", borderColor: "#fbbf24" };
  if (room.chat?.needsReview) return { background: "#f5f3ff", borderColor: "#a78bfa" };
  return undefined;
}

const SORTS = {
  activity: (a, b) => (b.users || 0) - (a.users || 0) || (b.strokes || 0) - (a.strokes || 0),
  recent: (a, b) => (b.lastActivity || 0) - (a.lastActivity || 0),
  newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  chats: (a, b) => (b.chats || 0) - (a.chats || 0),
  reports: (a, b) =>
    (b.reports?.open || 0) - (a.reports?.open || 0) ||
    (b.reports?.urgent || 0) - (a.reports?.urgent || 0) ||
    (b.reports?.total || 0) - (a.reports?.total || 0),
  concerns: (a, b) => concernScore(b) - concernScore(a),
};
const SORT_LABELS = {
  activity: "Activity",
  recent: "Recent",
  newest: "Newest",
  chats: "Chats",
  reports: "Reports",
  concerns: "Concerns",
};

// The room's latest baked thumbnail — same pattern as LiveAdmin's RoomThumb:
// fetched with the admin header (an <img src> can't carry one) and re-fetched
// only when the server reports a newer bake.
function RoomThumb({ id, thumbAt, adminKey }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!thumbAt) {
      setSrc(null);
      return undefined;
    }
    let cancelled = false;
    let url = null;
    fetch(`/api/admin/rooms/${encodeURIComponent(id)}/thumb?_=${thumbAt}`, { headers: { "x-admin-key": adminKey }, cache: "no-store" })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, thumbAt, adminKey]);
  if (!src) {
    return <div className="admin-room-thumb is-empty">{thumbAt ? "loading…" : "no snapshot yet"}</div>;
  }
  return <img className="admin-room-thumb" src={src} alt={`Room ${id} right now`} title={`baked ${timeAgo(thumbAt)}`} />;
}

export default function RoomRadar({ onNavigate }) {
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
  const [totals, setTotals] = useState(null);
  const [lastFetchAt, setLastFetchAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [onlyPeople, setOnlyPeople] = useState(false);
  const [onlyReports, setOnlyReports] = useState(false);
  const [onlyReview, setOnlyReview] = useState(false);
  const [audience, setAudience] = useState("all");
  const [sort, setSort] = useState("activity");
  const [sortAsc, setSortAsc] = useState(false);
  const [selected, setSelected] = useState(null); // room id with the detail drawer open
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [flagQuery, setFlagQuery] = useState("");

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

  const load = useCallback(async () => {
    if (!adminKey) return;
    try {
      const res = await fetch(bust("/api/admin/radar"), { headers: { "x-admin-key": adminKey }, cache: "no-store" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      setTotals(data.totals || null);
      setLastFetchAt(Date.now());
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

  // Poll while the tab is visible; clear everything on unmount.
  useEffect(() => {
    if (!authed) return undefined;
    load();
    const timer = window.setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authed, load]);

  // 1s ticker so "updated Ns ago" and the timeAgo labels stay honest.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Fetch the deterministic chat summary when a row's drawer is opened.
  useEffect(() => {
    if (!selected || !adminKey) {
      setSummary(null);
      return undefined;
    }
    let cancelled = false;
    setSummaryLoading(true);
    fetch(bust(`/api/admin/rooms/${encodeURIComponent(selected)}/chat/summary`), { headers: { "x-admin-key": adminKey }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        setSummary(data);
        setSummaryLoading(false);
      })
      .catch(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, adminKey]);

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

  const clickSort = (key) => {
    if (key === sort) {
      setSortAsc((v) => !v);
    } else {
      setSort(key);
      setSortAsc(false);
    }
  };

  const visibleRooms = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rooms.filter((room) => {
      if (q && !String(room.id).toLowerCase().includes(q) && !String(room.title || "").toLowerCase().includes(q)) return false;
      if (onlyPeople && !(room.users > 0)) return false;
      if (onlyReports && !(room.reports?.open > 0)) return false;
      if (onlyReview && !(room.chat?.needsReview || room.reports?.open > 0)) return false;
      if (audience === "kid_safe" && room.audience !== "kid_safe") return false;
      if (audience === "other" && (!room.audience || room.audience === "kid_safe")) return false;
      if (audience === "listed" && room.listed === false) return false;
      if (audience === "unlisted" && room.listed !== false) return false;
      return true;
    });
    const cmp = SORTS[sort] || SORTS.activity;
    filtered.sort((a, b) => (sortAsc ? cmp(b, a) : cmp(a, b)));
    return filtered;
  }, [rooms, query, onlyPeople, onlyReports, onlyReview, audience, sort, sortAsc]);

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

  const shown = visibleRooms.slice(0, ROW_CAP);
  const selectedRoom = selected ? rooms.find((r) => r.id === selected) : null;
  const digest = summary?.digest || selectedRoom?.chat || null;
  const updatedAgo = lastFetchAt ? Math.max(0, Math.floor((now - lastFetchAt) / 1000)) : null;
  const flaggedLines = (digest?.flagged || []).filter((line) => {
    const q = flagQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      String(line.name || "").toLowerCase().includes(q) ||
      String(line.message || "").toLowerCase().includes(q) ||
      (Array.isArray(line.terms) && line.terms.some((t) => String(t).toLowerCase().includes(q))) ||
      (Array.isArray(line.why) && line.why.some((w) => String(w).toLowerCase().includes(q)))
    );
  });

  return (
    <main className="admin-portal">
      <header className="admin-top">
        <h1>📡 Room Radar</h1>
        <div className="admin-top-actions">
          <span className="admin-muted" style={{ alignSelf: "center" }}>
            {updatedAgo == null ? "loading…" : `updated ${updatedAgo}s ago`}
          </span>
          <button type="button" onClick={() => onNavigate("/admin")}>
            ← Admin
          </button>
          <button type="button" onClick={load}>
            Refresh
          </button>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="admin-section">
        <div className="metric-grid">
          <div className="metric">
            <span className="metric-num">{totals?.rooms ?? rooms.length}</span>
            <span className="metric-label">Rooms</span>
            <span className="metric-sub">whole estate</span>
          </div>
          <div className="metric">
            <span className="metric-num">{totals?.occupied ?? 0}</span>
            <span className="metric-label">Occupied</span>
            <span className="metric-sub">someone painting now</span>
          </div>
          <div className="metric">
            <span className={`metric-num ${(totals?.needsReview || 0) > 0 ? "is-warn" : "is-ok"}`}>{totals?.needsReview ?? 0}</span>
            <span className="metric-label">Need review</span>
            <span className="metric-sub">chat digest or open report</span>
          </div>
          <div className="metric">
            <span className={`metric-num ${(totals?.openReports || 0) > 0 ? "is-warn" : "is-ok"}`}>{totals?.openReports ?? 0}</span>
            <span className="metric-label">Open reports</span>
            <span className="metric-sub">{totals?.withOpenReports ?? 0} rooms affected</span>
          </div>
          <div className="metric">
            <span className={`metric-num ${(totals?.urgentReports || 0) > 0 ? "is-bad" : "is-ok"}`}>{totals?.urgentReports ?? 0}</span>
            <span className="metric-label">Urgent</span>
            <span className="metric-sub">rooms with urgent reports</span>
          </div>
        </div>
      </section>

      <section className="admin-section">
        <div className="admin-chat-filters">
          <label>
            Search
            <input
              type="search"
              value={query}
              placeholder="room code or title"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            Audience
            <select value={audience} onChange={(e) => setAudience(e.target.value)}>
              <option value="all">All rooms</option>
              <option value="kid_safe">Kid-safe</option>
              <option value="other">Other audience</option>
              <option value="listed">Listed</option>
              <option value="unlisted">Unlisted</option>
            </select>
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={onlyPeople} onChange={(e) => setOnlyPeople(e.target.checked)} />
            With people only
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={onlyReports} onChange={(e) => setOnlyReports(e.target.checked)} />
            Open reports only
          </label>
          <label className="admin-check">
            <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} />
            Needs review only
          </label>
        </div>

        <div className="admin-tabs" role="group" aria-label="Sort rooms by">
          {Object.keys(SORT_LABELS).map((key) => (
            <button
              key={key}
              type="button"
              className={sort === key ? "is-active" : ""}
              onClick={() => clickSort(key)}
              title={`Sort by ${SORT_LABELS[key].toLowerCase()}${sort === key ? (sortAsc ? " (ascending)" : " (descending)") : ""}`}
            >
              {SORT_LABELS[key]}
              {sort === key ? (sortAsc ? " ▲" : " ▼") : ""}
            </button>
          ))}
        </div>

        {visibleRooms.length > ROW_CAP ? (
          <p className="admin-muted" style={{ margin: "0 0 10px" }}>
            showing {ROW_CAP} of {visibleRooms.length} — narrow with search or filters
          </p>
        ) : null}

        {shown.length === 0 ? (
          <p className="admin-empty">No rooms match — loosen the search or filters.</p>
        ) : (
          <div className="admin-list">
            {shown.map((room) => {
              const reports = room.reports || {};
              const chat = room.chat || {};
              const tint = rowTint(room);
              const left = formatLeft(room.expiresInMs);
              return (
                <div
                  key={room.id}
                  className="admin-report"
                  style={tint}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setFlagQuery("");
                    setSelected(selected === room.id ? null : room.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setFlagQuery("");
                      setSelected(selected === room.id ? null : room.id);
                    }
                  }}
                >
                  <div className="admin-report-main">
                    <strong>
                      Room {room.id}
                      {room.title ? ` — ${room.title}` : ""}
                    </strong>{" "}
                    {reports.urgent > 0 ? <span className="admin-badge">⚑ {reports.urgent} urgent</span> : null}
                    {reports.open > 0 ? <span className="admin-badge" style={{ background: "#d97706" }}>{reports.open} open</span> : null}
                    {!reports.open && chat.needsReview ? (
                      <span className="admin-badge" style={{ background: "#7c3aed" }}>chat review</span>
                    ) : null}
                    <span className="admin-muted">
                      {room.users} painting · {room.strokes} strokes · {room.chats || 0} chats · active {timeAgo(room.lastActivity)}
                      {" · "}
                      {room.audience === "kid_safe" ? "kid-safe" : room.audience || "any audience"}
                      {room.listed === false ? " · unlisted" : ""}
                      {room.featured ? " · featured" : ""}
                      {left ? ` · auto-closes in ${left}` : ""}
                    </span>
                    {reports.total > 0 ? (
                      <p className="admin-reason">
                        🚩 {reports.open}/{reports.total} reports open{reports.urgent > 0 ? ` (${reports.urgent} urgent)` : ""}
                        {reports.lastReason ? ` — “${reports.lastReason}”` : ""} · {timeAgo(reports.lastTs)}
                        {reports.lastSource ? ` · via ${reports.lastSource}` : ""}
                      </p>
                    ) : null}
                    {chat.needsReview ? (
                      <p className="admin-reason">
                        💬 chat: {chat.blocked || 0} blocked ({chat.severe || 0} severe) · {chat.contact || 0} contact-sharing ·{" "}
                        {chat.concern || 0} concern phrases{chat.lastFlaggedTs ? ` · last ${timeAgo(chat.lastFlaggedTs)}` : ""}
                      </p>
                    ) : null}
                  </div>
                  <div className="admin-actions">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate(`/watch/${room.id}`);
                      }}
                    >
                      🕵️ Watch
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onNavigate(`/join/${room.id}`);
                      }}
                    >
                      Open
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {selectedRoom ? (
        <section className="admin-section">
          <h2>
            Room {selectedRoom.id} {selectedRoom.title ? `— ${selectedRoom.title}` : ""}
          </h2>
          <div className="admin-report" style={rowTint(selectedRoom)}>
            <RoomThumb id={selectedRoom.id} thumbAt={selectedRoom.thumbAt} adminKey={adminKey} />
            <div className="admin-report-main admin-room-main">
              <span className="admin-muted">
                {selectedRoom.users} painting · {selectedRoom.strokes} strokes · {selectedRoom.hiddenOps || 0} hidden ops ·{" "}
                {selectedRoom.modActions || 0} mod actions · {selectedRoom.flagged || 0} flags · created {timeAgo(selectedRoom.createdAt)}
                {selectedRoom.host ? " · has host" : ""}
                {selectedRoom.animation ? " · animation" : ""}
              </span>
              {summaryLoading ? <p className="admin-muted">Summarising chat…</p> : null}
              {summary?.summary ? <p className="admin-reason">{summary.summary}</p> : null}
              {summary?.llm?.summary ? (
                <p className="admin-reason">
                  <em>LLM: {summary.llm.summary}</em>
                </p>
              ) : null}
              {digest ? (
                <span className="admin-muted">
                  digest: {digest.lines || 0} lines · {digest.blocked || 0} blocked ({digest.severe || 0} severe, {digest.mild || 0} mild)
                  {" · "}
                  {digest.contact || 0} contact · {digest.concern || 0} concern · {digest.doodles || 0} doodles
                  {digest.lastTs ? ` · last line ${timeAgo(digest.lastTs)}` : ""}
                </span>
              ) : null}
              {digest?.terms?.length ? (
                <span className="admin-muted">
                  terms:{" "}
                  {digest.terms.map((t, i) => (
                    <span key={t.term}>
                      {i > 0 ? ", " : ""}
                      {t.severe ? <strong style={{ color: "#b91c1c" }}>{t.term}×{t.count}</strong> : `${t.term}×${t.count}`}
                    </span>
                  ))}
                </span>
              ) : null}
              {digest?.authors?.length ? (
                <span className="admin-muted">
                  top talkers: {digest.authors.map((a) => `${a.name} (${a.count})`).join(", ")}
                </span>
              ) : null}
              <div className="admin-actions">
                <button type="button" onClick={() => onNavigate(`/join/${selectedRoom.id}`)}>
                  Open room
                </button>
                <button type="button" onClick={() => onNavigate(`/watch/${selectedRoom.id}`)}>
                  🕵️ Watch (invisible)
                </button>
                <button type="button" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>

          <h2 style={{ marginTop: 18 }}>
            Flagged chat lines {digest?.flagged?.length ? <span className="admin-badge">{digest.flagged.length}</span> : null}
          </h2>
          <div className="admin-chat-filters">
            <label>
              Filter flagged lines
              <input
                type="search"
                value={flagQuery}
                placeholder="name, word or reason"
                onChange={(e) => setFlagQuery(e.target.value)}
              />
            </label>
          </div>
          {flaggedLines.length === 0 ? (
            <p className="admin-empty">
              {digest?.flagged?.length ? "Nothing matches that filter." : "No flagged chat in this room. 🎉"}
            </p>
          ) : (
            <div className="admin-chat-log">
              {flaggedLines.map((line, i) => (
                <div key={`${line.ts}-${i}`} className={line.blocked ? "admin-chat-row is-blocked" : "admin-chat-row"}>
                  <span className="admin-chat-when">{clock(line.ts)}</span>
                  <span className="admin-chat-who">
                    <strong>{line.name}</strong>
                    <small>{line.blocked ? `blocked:${line.blocked}` : (line.why || []).join(", ") || "flagged"}</small>
                  </span>
                  <span className="admin-chat-text">
                    {line.blocked ? (
                      <em className="admin-chat-flag">BLOCKED{line.terms?.length ? ` (${line.terms.join(", ")})` : ""} · </em>
                    ) : null}
                    {line.message || "(no text)"}
                    {line.why?.length ? <span className="admin-muted"> — {line.why.join(", ")}</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}
