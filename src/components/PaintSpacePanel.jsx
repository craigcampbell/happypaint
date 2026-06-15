// Paint Space locker UI. A modal showing saved assets grouped by kind in a
// thumbnail grid (reusing .gallery-item / .pack-card styling). Pure UI: it
// dispatches use/rename/delete back to StudioApp, which owns persistence and
// the apply-to-canvas flows.

import { ASSET_KINDS, groupByKind } from "../utils/paintSpace";

function PaletteSwatches({ colors = [] }) {
  return (
    <div className="ps-palette-swatches" aria-hidden="true">
      {colors.slice(0, 8).map((color, index) => (
        <span key={`${color}-${index}`} style={{ backgroundColor: color }} />
      ))}
    </div>
  );
}

function AssetCard({ asset, onUse, onRename, onDelete }) {
  return (
    <article className="gallery-item ps-asset">
      {asset.kind === "palette" ? (
        <PaletteSwatches colors={asset.payload?.colors} />
      ) : asset.thumbnail ? (
        <img src={asset.thumbnail} alt="" />
      ) : (
        <span className="frame-empty" />
      )}
      <span title={asset.title}>{asset.title}</span>
      <div className="ps-asset-actions">
        <button type="button" onClick={() => onUse(asset)} title="Use this asset">
          Use
        </button>
        <button type="button" onClick={() => onRename(asset)} title="Rename">
          Rename
        </button>
        <button type="button" onClick={() => onDelete(asset)} title="Delete">
          Del
        </button>
      </div>
    </article>
  );
}

export default function PaintSpacePanel({ assets, onClose, onUse, onRename, onDelete }) {
  const groups = groupByKind(assets);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal paint-space-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paint-space-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="paint-space-title">Paint Space</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="ps-subtitle">Your private locker of reusable stickers, templates, palettes, and loops.</p>

        {assets.length === 0 ? (
          <div className="empty-gallery ps-empty">Nothing saved yet. Use the Save buttons in the studio.</div>
        ) : (
          ASSET_KINDS.map((kind) => {
            const items = groups[kind.id] || [];
            if (items.length === 0) {
              return null;
            }
            return (
              <div className="ps-group" key={kind.id}>
                <h3>{kind.label}</h3>
                <div className="ps-grid">
                  {items.map((asset) => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      onUse={onUse}
                      onRename={onRename}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
