// Layers section for the studio tool-rail. Pure UI: it renders the current
// layer stack (top-to-bottom for natural reading) and dispatches actions back
// to StudioApp, which owns all canvas/state mutation.

export default function LayerPanel({
  layers,
  activeLayerId,
  onSelect,
  onAdd,
  onDelete,
  onDuplicate,
  onMergeDown,
  onMoveUp,
  onMoveDown,
  onToggleVisible,
  onToggleLock,
  onRename,
  onOpacityChange,
}) {
  // Render top layer first so the panel reads the same way it stacks visually.
  const ordered = layers.slice().reverse();

  return (
    <section className="tool-section layer-panel">
      <div className="section-title-row">
        <h2>Layers</h2>
        <button type="button" onClick={onAdd} aria-label="Add layer">
          + Add
        </button>
      </div>
      <div className="layer-list">
        {ordered.map((layer) => {
          const index = layers.findIndex((item) => item.id === layer.id);
          const isActive = layer.id === activeLayerId;
          const canMoveUp = index < layers.length - 1;
          const canMoveDown = index > 0;
          return (
            <div
              key={layer.id}
              className={`layer-row ${isActive ? "is-active" : ""} ${layer.locked ? "is-locked" : ""}`}
            >
              <div className="layer-row-main">
                <button
                  type="button"
                  className={`layer-visibility ${layer.visible ? "is-on" : ""}`}
                  onClick={() => onToggleVisible(layer.id)}
                  aria-pressed={layer.visible}
                  aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
                  title={layer.visible ? "Hide layer" : "Show layer"}
                >
                  {layer.visible ? "👁" : "—"}
                </button>
                <button
                  type="button"
                  className="layer-name"
                  onClick={() => onSelect(layer.id)}
                  aria-pressed={isActive}
                  title="Select layer"
                >
                  <span>{layer.name}</span>
                  {layer.locked ? <small>Locked</small> : null}
                </button>
                <button
                  type="button"
                  className={`layer-lock ${layer.locked ? "is-on" : ""}`}
                  onClick={() => onToggleLock(layer.id)}
                  aria-pressed={layer.locked}
                  aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
                  title={layer.locked ? "Unlock layer" : "Lock layer"}
                >
                  {layer.locked ? "🔒" : "🔓"}
                </button>
              </div>

              {isActive ? (
                <div className="layer-row-detail">
                  <label className="layer-opacity">
                    <span>Opacity</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={Math.round(layer.opacity * 100)}
                      onChange={(event) => onOpacityChange(layer.id, Number(event.target.value) / 100)}
                    />
                    <output>{Math.round(layer.opacity * 100)}%</output>
                  </label>
                  <div className="layer-actions">
                    <button type="button" onClick={() => onMoveUp(layer.id)} disabled={!canMoveUp} title="Move up">
                      ↑
                    </button>
                    <button type="button" onClick={() => onMoveDown(layer.id)} disabled={!canMoveDown} title="Move down">
                      ↓
                    </button>
                    <button type="button" onClick={() => onRename(layer.id)} title="Rename">
                      Rename
                    </button>
                    <button type="button" onClick={() => onDuplicate(layer.id)} title="Duplicate">
                      Dup
                    </button>
                    <button
                      type="button"
                      onClick={() => onMergeDown(layer.id)}
                      disabled={!canMoveDown}
                      title="Merge down"
                    >
                      Merge
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(layer.id)}
                      disabled={layers.length <= 1}
                      title="Delete layer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
