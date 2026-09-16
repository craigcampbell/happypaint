// Admin gallery inspector — the moderation view over every saved artwork,
// INCLUDING anonymous saves. The analytics tab can only count saves; this page
// shows the pictures themselves, grouped per owner (device or account), with a
// full-image lightbox and a confirmed remove. Anonymous owners are flagged up
// front because nobody else can review what an unsigned-in kid saved.

import { useCallback, useEffect, useMemo, useState } from "react";

const KEY_STORAGE = "drawesome:adminkey:v1";

function timeAgo(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function formatCount(value) {
  return Math.round(Number(value) || 0).toLocaleString();
}

function clock(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const SORTS = [
  ["newest", "Newest save"],
  ["oldest", "Oldest save"],
  ["most", "Most items"],
  ["key", "Owner key"],
];

const FILTERS = [
  ["all", "All owners"],
  ["anon", "Anonymous only"],
  ["accounts", "Accounts only"],
];

export default function AdminGallery({ onNavigate }) {
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
  const [owners, setOwners] = useState([]);
  const [totals, setTotals] = useState(null);
  const [recent, setRecent] = useState([]);
  const [sort, setSort] = useState("newest");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  // Expanded owner + lazily fetched items per ownerKey: { loading, items }.
  const [openOwner, setOpenOwner] = useState("");
  const [details, setDetails] = useState({});
  const [lightbox, setLightbox] = useState(null); // { ownerKey, item }
  const [removing, setRemoving] = useState(""); // `${ownerKey}/${id}` in flight
  const [toast, setToast] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  // A slow tick so "updated Ns ago" and timeAgo labels stay honest.
  const [, setTick] = useState(0);

  // A unique query string per request defeats any stale service-worker / proxy
  // cache (a cached 401 would otherwise lock you out no matter the key).
  const bust = (path) => `${path}${path.includes("?") ? "&" : "?"}_=${Date.now()}`;

  const say = useCallback((text) => {
    setToast(text);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

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
      const res = await fetch(bust("/api/admin/gallery"), { headers: { "x-admin-key": adminKey }, cache: "no-store" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) return;
      const data = await res.json();
      setOwners(Array.isArray(data.owners) ? data.owners : []);
      setTotals(data.totals || null);
      setRecent(Array.isArray(data.recent) ? data.recent : []);
      setAuthed(true);
      setUpdatedAt(Date.now());
    } catch {
      // leave as-is on a transient error
    }
  }, [adminKey]);

  useEffect(() => {
    if (adminKey) {
      checkKey(adminKey).then((ok) => setAuthed(ok));
    }
  }, [adminKey, checkKey]);

  // Poll the index every 20s, but only while the tab is actually visible —
  // a moderator leaving this open overnight shouldn't hammer the server.
  useEffect(() => {
    if (!authed) return undefined;
    refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh();
    }, 20000);
    const tick = window.setInterval(() => setTick((t) => t + 1), 5000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(tick);
    };
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

  // Expand/collapse an owner; items (thumb + full image data URLs) are fetched
  // lazily the first time an owner is opened so the index stays light.
  const toggleOwner = async (ownerKey) => {
    if (openOwner === ownerKey) {
      setOpenOwner("");
      return;
    }
    setOpenOwner(ownerKey);
    if (details[ownerKey]?.items) return;
    setDetails((d) => ({ ...d, [ownerKey]: { loading: true, items: d[ownerKey]?.items || null } }));
    try {
      const res = await fetch(bust(`/api/admin/gallery/${encodeURIComponent(ownerKey)}`), { headers: { "x-admin-key": adminKey }, cache: "no-store" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = res.ok ? await res.json() : null;
      setDetails((d) => ({ ...d, [ownerKey]: { loading: false, items: Array.isArray(data?.items) ? data.items : [] } }));
    } catch {
      setDetails((d) => ({ ...d, [ownerKey]: { loading: false, items: [] } }));
    }
  };

  // Confirmed removal: the button only ARMS the confirm dialog; the POST fires
  // after an explicit yes. On success the artwork leaves the grid and the
  // owner's count/totals shrink in place — no full reload.
  const removeArtwork = async (ownerKey, item) => {
    if (!window.confirm(`Remove "${item.name || item.id}" from ${ownerKey}? This deletes the saved image for everyone.`)) return;
    const tag = `${ownerKey}/${item.id}`;
    setRemoving(tag);
    try {
      const res = await fetch(`/api/admin/gallery/${encodeURIComponent(ownerKey)}/${encodeURIComponent(item.id)}/remove`, {
        method: "POST",
        headers: { "x-admin-key": adminKey },
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      const data = res.ok ? await res.json() : null;
      if (!data?.ok) throw new Error("remove failed");
      setDetails((d) => {
        const entry = d[ownerKey];
        if (!entry?.items) return d;
        return { ...d, [ownerKey]: { ...entry, items: entry.items.filter((it) => it.id !== item.id) } };
      });
      setOwners((list) => list.map((o) => (o.ownerKey === ownerKey ? { ...o, count: Math.max(0, Number(data.remaining) || o.count - 1) } : o)));
      setTotals((t) => (t ? { ...t, artworks: Math.max(0, (Number(t.artworks) || 0) - 1) } : t));
      setLightbox((lb) => (lb && lb.ownerKey === ownerKey && lb.item.id === item.id ? null : lb));
      say(`Removed. ${formatCount(data.remaining)} left for this owner.`);
    } catch {
      say("Couldn't remove that artwork — try again.");
    } finally {
      setRemoving("");
    }
  };

  // Client-side over the index: search matches the owner key OR any artwork
  // name the index listed for that owner.
  const visibleOwners = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = owners;
    if (filter === "anon") list = list.filter((o) => !o.signedIn);
    if (filter === "accounts") list = list.filter((o) => o.signedIn);
    if (q) {
      list = list.filter((o) => {
        if (String(o.ownerKey || "").toLowerCase().includes(q)) return true;
        return (o.items || []).some((it) => String(it.name || "").toLowerCase().includes(q));
      });
    }
    const by = {
      newest: (a, b) => (b.newest || 0) - (a.newest || 0),
      oldest: (a, b) => (a.oldest || 0) - (b.oldest || 0),
      most: (a, b) => (b.count || 0) - (a.count || 0),
      key: (a, b) => String(a.ownerKey).localeCompare(String(b.ownerKey)),
    }[sort] || (() => 0);
    return [...list].sort(by);
  }, [owners, filter, query, sort]);

  if (!authed) {
    return (
      <main className="admin-login">
        <div className="admin-login-card">
          <h1>🖼️ Gallery inspector</h1>
          <p>Enter your admin key to review saved artwork.</p>
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

  const t = totals || {};

  return (
    <main className="admin-portal">
      <header className="admin-top">
        <h1>🖼️ Gallery inspector</h1>
        <div className="admin-top-actions">
          <button type="button" onClick={() => onNavigate("/admin")}>
            ← Admin
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
          Saved artwork{" "}
          <span className="admin-muted" style={{ fontSize: "0.8rem" }}>
            {updatedAt ? `updated ${timeAgo(updatedAt)}` : "loading…"}
          </span>
        </h2>
        <div className="metric-grid">
          <div className="metric">
            <span className="metric-num">{formatCount(t.owners)}</span>
            <span className="metric-label">Owner galleries</span>
            <span className="metric-sub">devices + accounts with saves</span>
          </div>
          <div className="metric">
            <span className="metric-num">{formatCount(t.artworks)}</span>
            <span className="metric-label">Artworks</span>
            <span className="metric-sub">saved images on disk</span>
          </div>
          <div className="metric" style={{ borderColor: "#e2a63d", boxShadow: "0 0 0 2px rgba(226, 166, 61, 0.35)" }}>
            <span className="metric-num is-warn">{formatCount(t.anonymousOwners)}</span>
            <span className="metric-label">⚠ Anonymous owners</span>
            <span className="metric-sub">no account attached — review these first</span>
          </div>
          <div className="metric">
            <span className="metric-num">{formatCount(t.accountOwners)}</span>
            <span className="metric-label">Account owners</span>
            <span className="metric-sub">tied to a sign-in</span>
          </div>
        </div>
        <p className="admin-muted admin-note">
          Anonymous saves belong to a device key, not an account — they never appear in anyone&apos;s profile and
          this page is the only place they can be reviewed. Expand an owner to see the actual drawings.
        </p>
      </section>

      <section className="admin-section">
        <h2>
          Save feed <span className="admin-badge">{recent.length}</span>{" "}
          <span className="admin-muted" style={{ fontSize: "0.8rem" }}>analytics stream — saves land here before the file index refreshes</span>
        </h2>
        {recent.length === 0 ? (
          <p className="admin-empty">No saves recorded yet.</p>
        ) : (
          <div className="admin-mini-list">
            {recent.slice(0, 20).map((save, i) => (
              <div key={`${save.ts}-${i}`}>
                <strong>{save.signedIn ? `Account ${save.account || ""}` : "⚠ Anonymous"}</strong>
                <span>
                  {clock(save.ts)} · {save.country || "country unknown"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="admin-section">
        <h2>
          Owner galleries <span className="admin-badge">{visibleOwners.length}</span>
        </h2>
        <div className="admin-chat-filters">
          <label>
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Show
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {FILTERS.map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input type="search" value={query} placeholder="owner key or artwork name" onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>

        {visibleOwners.length === 0 ? (
          <p className="admin-empty">{owners.length === 0 ? "Nothing saved yet." : "No owners match that filter."}</p>
        ) : (
          <div className="admin-list">
            {visibleOwners.map((owner) => {
              const open = openOwner === owner.ownerKey;
              const detail = details[owner.ownerKey];
              const names = (owner.items || []).slice(0, 4).map((it) => it.name || it.id);
              return (
                <div key={owner.ownerKey} className="admin-report">
                  <button
                    type="button"
                    className="admin-report-main"
                    style={{ textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
                    onClick={() => toggleOwner(owner.ownerKey)}
                    aria-expanded={open}
                  >
                    <strong>
                      {open ? "▾" : "▸"} {owner.ownerKey}
                    </strong>{" "}
                    {owner.signedIn ? (
                      <span className="admin-badge">account {owner.account || "?"}</span>
                    ) : (
                      <span className="admin-badge" style={{ background: "#e2a63d", color: "#2b1d05" }}>Anonymous</span>
                    )}
                    <span className="admin-muted">
                      · {formatCount(owner.count)} saved · newest {timeAgo(owner.newest)} · oldest {timeAgo(owner.oldest)}
                    </span>
                    {names.length ? (
                      <p className="admin-reason">
                        {names.join(" · ")}
                        {owner.count > names.length ? ` · +${formatCount(owner.count - names.length)} more` : ""}
                      </p>
                    ) : null}
                  </button>
                  {open ? (
                    <div style={{ width: "100%" }}>
                      {detail?.loading ? (
                        <p className="admin-empty">Loading artwork…</p>
                      ) : !detail?.items || detail.items.length === 0 ? (
                        <p className="admin-empty">No artwork left for this owner.</p>
                      ) : (
                        <div className="admin-sheet-grid">
                          {detail.items.map((item) => (
                            <div key={item.id} className="admin-sheet">
                              <button type="button" style={{ background: "none", border: "none", padding: 0, cursor: "zoom-in" }} onClick={() => setLightbox({ ownerKey: owner.ownerKey, item })} title="Open full image">
                                {item.thumb ? (
                                  <img src={item.thumb} alt={item.name || item.id} loading="lazy" />
                                ) : (
                                  <span className="sheet-noimg">🎨</span>
                                )}
                              </button>
                              <span className="admin-sheet-name">{item.name || item.id}</span>
                              <span className="admin-muted" style={{ fontSize: "0.75rem" }}>{timeAgo(item.createdAt)}</span>
                              <button
                                type="button"
                                className="admin-danger"
                                disabled={removing === `${owner.ownerKey}/${item.id}`}
                                onClick={() => removeArtwork(owner.ownerKey, item)}
                              >
                                {removing === `${owner.ownerKey}/${item.id}` ? "Removing…" : "Remove"}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {lightbox ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setLightbox(null)}>
          <div className="studio-modal" role="dialog" aria-label={lightbox.item.name || "Saved artwork"} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: 0 }}>{lightbox.item.name || lightbox.item.id}</h3>
            <p className="admin-muted" style={{ margin: 0 }}>
              {lightbox.ownerKey} · saved {timeAgo(lightbox.item.createdAt)}
            </p>
            {lightbox.item.image ? (
              <img src={lightbox.item.image} alt={lightbox.item.name || "Saved artwork"} style={{ width: "100%", borderRadius: 8, background: "#fff", border: "1px solid #c3cdd7" }} />
            ) : (
              <p className="admin-empty">Full image unavailable.</p>
            )}
            <div className="admin-actions" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="admin-danger"
                disabled={removing === `${lightbox.ownerKey}/${lightbox.item.id}`}
                onClick={() => removeArtwork(lightbox.ownerKey, lightbox.item)}
              >
                {removing === `${lightbox.ownerKey}/${lightbox.item.id}` ? "Removing…" : "Remove artwork"}
              </button>
              <button type="button" className="primary-action" onClick={() => setLightbox(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="wall-toast" role="status">{toast}</div> : null}
    </main>
  );
}
