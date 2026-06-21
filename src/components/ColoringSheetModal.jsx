// Coloring-sheet picker modal. Fetches the filename-derived search index once
// (cached across opens), searches in-browser over 6k+ sheets, shows a thumbnail
// grid + a preview, and applies the chosen sheet via onApply({id, title}).

import { useEffect, useMemo, useState } from "react";

let cachedSheets = null; // module-level cache so reopening is instant

export default function ColoringSheetModal({ onClose, onApply }) {
  const [all, setAll] = useState(cachedSheets || []);
  const [loading, setLoading] = useState(!cachedSheets);
  const [query, setQuery] = useState("");
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

  // Token-AND search over the searchable text + title; cap the rendered set.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 120);
    const tokens = q.split(/\s+/);
    const out = [];
    for (const s of all) {
      const hay = `${s.q} ${s.title.toLowerCase()}`;
      if (tokens.every((t) => hay.includes(t))) {
        out.push(s);
        if (out.length >= 240) break;
      }
    }
    return out;
  }, [query, all]);

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
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={loading ? "Loading sheets…" : `Search ${all.length.toLocaleString()} sheets — try “dinosaur”, “butterfly”, “birthday”…`}
        />
        <p className="sheet-count">
          {loading
            ? "Loading…"
            : `${results.length}${results.length >= 240 ? "+" : ""} ${results.length === 1 ? "sheet" : "sheets"}${query ? "" : " — type to search"}`}
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
              <img
                src={`/coloring-sheets/thumbs/${encodeURIComponent(s.id)}.webp`}
                alt={s.title}
                loading="lazy"
              />
              <span>{s.title}</span>
            </button>
          ))}
          {!loading && results.length === 0 ? (
            <p className="sheet-empty">No sheets match “{query}”. Try another word.</p>
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
            <span className="sheet-hint">Tap a sheet to preview it, then add it to your canvas.</span>
          )}
        </div>
      </section>
    </div>
  );
}
