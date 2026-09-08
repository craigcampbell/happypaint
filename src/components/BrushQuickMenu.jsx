import BrushPreview from "./BrushPreview";

// The quick brush menu that pops up from the Size pill on the bottom bar: a
// size slider (precision, for when a drag is too coarse) and the brush grid.
// `items` is prepared by the studio — [{ id, name, locked, gated }] — with the
// same room gating the tool rail applies (finger-paint rooms, private-only
// smudge, Studio-tier brushes), so both pickers always agree.

export const BRUSH_SIZE_MIN = 2;
export const BRUSH_SIZE_MAX = 120;

export default function BrushQuickMenu({
  items,
  selectedBrush,
  selectedTool,
  color,
  size,
  onSize,
  onChoose,
  onClose,
}) {
  return (
    <div className="bqm" role="dialog" aria-label="Brush">
      <div className="cw-head">
        <span className="cw-title">Brush</span>
        <button type="button" className="cw-close" onClick={onClose} aria-label="Close brush menu">
          ✕
        </button>
      </div>
      <label className="cw-row bqm-size">
        <span className="cw-row-label">Size</span>
        <input
          type="range"
          className="cw-range cw-range-plain"
          min={BRUSH_SIZE_MIN}
          max={BRUSH_SIZE_MAX}
          value={size}
          aria-label="Brush size"
          aria-valuetext={`${size} pixels`}
          onChange={(event) => onSize(Number(event.target.value))}
        />
        <output className="cw-row-out">{size}</output>
      </label>
      <div className="bqm-grid">
        {items.map((item) => {
          const active = selectedTool === "brush" && selectedBrush === item.id;
          return (
            <button
              type="button"
              key={item.id}
              className={`bqm-chip${active ? " is-active" : ""}${item.gated ? " is-gated" : ""}`}
              onClick={() => onChoose(item)}
              aria-pressed={active}
              aria-disabled={item.gated || undefined}
            >
              <BrushPreview brush={item.id} color={color} />
              <span className="bqm-name">{item.name}</span>
              {item.locked ? <small>Studio</small> : null}
              {item.gated ? <small>🔒 Private</small> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
