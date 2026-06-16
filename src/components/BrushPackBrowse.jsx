// Community Brush Pack browse surface.
//
// Shows APPROVED + public brush packs (seed packs + any locally-approved pack).
// Browse is by pack / topic — NOT by finding people (no public people search).
// Each card shows: name, preview swatches, tags, author space, and the remix
// permission. "Get / Add to my brushes" copies the pack's brushes into the
// user's locker (records asset_uses); StudioApp owns the locker write so the
// onGet callback hands the new assets up.

import { useMemo, useState } from "react";
import { getBrowsablePacks, remixLabel } from "../utils/brushPacks";

function PackPreview({ items, accent }) {
  // Render up to 3 small recipe-color swatches as a lightweight preview.
  const swatches = (items || []).slice(0, 3);
  return (
    <div className="brush-pack-preview" style={{ "--pack-accent": accent || "#22c55e" }} aria-hidden="true">
      {swatches.length > 0 ? (
        swatches.map((item, index) => <i key={index} />)
      ) : (
        <i />
      )}
    </div>
  );
}

function PackCard({ pack, onGet, gotPackIds }) {
  const got = gotPackIds.includes(pack.id);
  const brushCount = (pack.items || []).filter((item) => (item.asset || item).kind === "brush").length;
  return (
    <article className="pack-card brush-pack-card">
      <PackPreview items={pack.items} accent={pack.accent} />
      <h3 title={pack.title}>{pack.title}</h3>
      <p className="brush-pack-author">{pack.authorSpace}</p>
      <div className="mini-tag-row">
        {(pack.tags || []).slice(0, 4).map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <p className="brush-pack-remix">{remixLabel(pack.remix_permission)} · {brushCount} brushes</p>
      <button type="button" className="full-width" disabled={got} onClick={() => onGet(pack)}>
        {got ? "Added to your brushes" : "Get — add to my brushes"}
      </button>
    </article>
  );
}

export default function BrushPackBrowse({ query = "", onGet }) {
  const [gotPackIds, setGotPackIds] = useState([]);
  const [notice, setNotice] = useState(
    "Community packs are moderated before they go public. Browse by pack and topic — never by searching for people.",
  );

  const packs = useMemo(() => {
    const all = getBrowsablePacks();
    const q = query.trim().toLowerCase();
    if (!q) {
      return all;
    }
    return all.filter((pack) => {
      const haystack = [pack.title, pack.authorSpace, ...(pack.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [query]);

  const handleGet = async (pack) => {
    const added = await onGet?.(pack);
    if (added === false) {
      setNotice("Couldn't add those brushes — storage may be full.");
      return;
    }
    setGotPackIds((current) => (current.includes(pack.id) ? current : [...current, pack.id]));
    setNotice(`Added "${pack.title}" brushes to your Paint Space.`);
  };

  return (
    <section className="brush-pack-browse" id="brush-packs" aria-label="Community brush packs">
      <div className="panel-title-row">
        <h3>Community Brush Packs</h3>
        <span>{packs.length} packs</span>
      </div>
      <p className="discovery-notice">{notice}</p>
      <div className="brush-pack-grid">
        {packs.length === 0 ? (
          <p className="event-empty">No packs match that search yet.</p>
        ) : (
          packs.map((pack) => (
            <PackCard key={pack.id} pack={pack} onGet={handleGet} gotPackIds={gotPackIds} />
          ))
        )}
      </div>
    </section>
  );
}
