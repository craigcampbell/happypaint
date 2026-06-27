// Coloring-sheet picker modal. Fetches the filename-derived search index once
// (cached across opens), then lets kids browse by CATEGORY chips and/or search
// in-browser over 6k+ sheets. Shows a thumbnail grid + preview, and applies the
// chosen sheet via onApply({id, title}).

import { useEffect, useMemo, useState } from "react";

let cachedSheets = null; // module-level cache so reopening is instant

// Keys match scripts/prep-sheets.mjs CATEGORY_KEYWORDS. "all" is the default.
const CATEGORIES = [
  { key: "all", label: "All", emoji: "✨" },
  { key: "animals", label: "Animals", emoji: "🐾" },
  { key: "fantasy", label: "Fantasy", emoji: "🦄" },
  { key: "holidays", label: "Holidays", emoji: "🎉" },
  { key: "nature", label: "Nature", emoji: "🌳" },
  { key: "food", label: "Food", emoji: "🍰" },
  { key: "vehicles", label: "Vehicles", emoji: "🚗" },
  { key: "sports", label: "Sports", emoji: "⚽" },
  { key: "people", label: "People", emoji: "👧" },
  { key: "birthday", label: "Birthday", emoji: "🎂" },
  { key: "learning", label: "ABC & 123", emoji: "🔤" },
  { key: "other", label: "More", emoji: "🎨" },
];

// Deterministic shuffle so the default browse view is varied (not a wall of
// alphabetical birthdays) but stable within a session.
function shuffled(arr) {
  const a = arr.slice();
  let seed = 1337;
  for (let i = a.length - 1; i > 0; i -= 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = Math.floor((seed / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export default function ColoringSheetModal({ onClose, onApply }) {
  const [all, setAll] = useState(cachedSheets || []);
  const [loading, setLoading] = useState(!cachedSheets);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (cachedSheets) return undefined;
    let active = true;
    fetch("/api/coloring-sheets")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active) return;
        cachedSheets = Array.isArray(d?.sheets) ? d.sheets : [];
        setAll(cachedSheets);
        setLoading(false);
      })
      .catch(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  // Shuffle once so the default + category views feel varied.
  const browseOrder = useMemo(() => shuffled(all), [all]);

  // How many sheets fall in each category (to hide empty chips + show counts).
  const catCounts = useMemo(() => {
    const m = { all: all.length };
    for (const s of all) for (const c of s.cats || []) m[c] = (m[c] || 0) + 1;
    return m;
  }, [all]);

  // Filter by category AND token-AND search; cap the rendered set.
  const results = useMemo(() => {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const s of browseOrder) {
      if (category !== "all" && !(s.cats || []).includes(category)) continue;
      if (tokens.length) {
        const hay = `${s.q} ${s.title.toLowerCase()}`;
        if (!tokens.every((t) => hay.includes(t))) continue;
      }
      out.push(s);
      if (out.length >= 240) break;
    }
    return out;
  }, [query, category, browseOrder]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal sheet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="sheet-modal-title">🎨 Coloring sheets</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <input
          className="sheet-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={loading ? "Loading sheets…" : `Search ${all.length.toLocaleString()} sheets — try “dinosaur”, “butterfly”…`}
        />

        <div className="sheet-cats" role="tablist" aria-label="Categories">
          {CATEGORIES.filter((c) => c.key === "all" || (catCounts[c.key] || 0) > 0).map((c) => (
            <button
              key={c.key}
              type="button"
              role="tab"
              aria-selected={category === c.key}
              className={`sheet-cat ${category === c.key ? "is-active" : ""}`}
              onClick={() => setCategory(c.key)}
            >
              <span aria-hidden="true">{c.emoji}</span> {c.label}
            </button>
          ))}
        </div>

        <p className="sheet-count">
          {loading
            ? "Loading…"
            : `${results.length}${results.length >= 240 ? "+" : ""} ${results.length === 1 ? "sheet" : "sheets"}`}
        </p>

        <div className="sheet-grid">
          {results.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sheet-card ${selected?.id === s.id ? "is-selected" : ""}`}
              onClick={() => setSelected(s)}
              title={s.title}
            >
              <img src={`/coloring-sheets/thumbs/${encodeURIComponent(s.id)}.webp`} alt={s.title} loading="lazy" />
              <span>{s.title}</span>
            </button>
          ))}
          {!loading && results.length === 0 ? (
            <p className="sheet-empty">No sheets here. Try another category or search word.</p>
          ) : null}
        </div>

        <div className="sheet-footer">
          {selected ? (
            <>
              <div className="sheet-preview">
                <img src={`/coloring-sheets/thumbs/${encodeURIComponent(selected.id)}.webp`} alt={selected.title} />
                <span className="sheet-selected-name">{selected.title}</span>
              </div>
              <div className="sheet-footer-actions">
                <button type="button" onClick={onClose}>
                  Cancel
                </button>
                <button type="button" className="primary-action" onClick={() => onApply(selected)}>
                  Use this sheet
                </button>
              </div>
            </>
          ) : (
            <span className="sheet-hint">Pick a category or search, tap a sheet to preview, then add it.</span>
          )}
        </div>
      </section>
    </div>
  );
}
