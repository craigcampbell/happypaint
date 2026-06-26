// Tiny Animation Loops UI for the tool-rail. Pure presentation: it renders the
// frame thumbnails, onion-skin/play controls, and per-frame duration, then
// dispatches actions back to StudioApp which owns all canvas/frame mutation.
//
// Starts unobtrusive: with a single frame it shows just the "Add frame" affordance.

export default function FrameStrip({
  frames,
  activeFrameIndex,
  thumbnails,
  isPlaying,
  onionSkin,
  isExporting,
  onSelectFrame,
  onAddFrame,
  onDuplicateFrame,
  onDeleteFrame,
  onMoveFrame,
  onDurationChange,
  onTogglePlay,
  onToggleOnion,
  onExportGif,
  onSaveLoop,
}) {
  const activeFrame = frames[activeFrameIndex];
  const multiFrame = frames.length > 1;

  return (
    <section className="tool-section frame-strip" aria-label="Animation loop">
      <div className="section-title-row">
        <h2>Loop</h2>
        <div className="frame-strip-controls">
          <button
            type="button"
            className={`onion-toggle ${onionSkin ? "is-on" : ""}`}
            onClick={onToggleOnion}
            aria-pressed={onionSkin}
            title="Onion skin (show neighbour frames faintly)"
          >
            Onion
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={!multiFrame}
            aria-pressed={isPlaying}
            title={multiFrame ? "Play / pause loop" : "Add a frame to preview"}
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
        </div>
      </div>

      <div className="frame-list" role="list">
        {frames.map((frame, index) => {
          const isActive = index === activeFrameIndex;
          return (
            <div key={frame.id} className={`frame-cell ${isActive ? "is-active" : ""}`} role="listitem">
              <button
                type="button"
                className="frame-thumb"
                onClick={() => onSelectFrame(index)}
                aria-pressed={isActive}
                aria-label={`Frame ${index + 1}`}
                title={`Frame ${index + 1}`}
              >
                {thumbnails[frame.id] ? <img src={thumbnails[frame.id]} alt="" /> : <span className="frame-empty" />}
                <small>{index + 1}</small>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="frame-add"
          onClick={onAddFrame}
          title="Add blank frame"
          aria-label="Add frame"
        >
          +
        </button>
      </div>

      {activeFrame ? (
        <div className="frame-detail">
          <label className="frame-duration">
            <span>Frame {activeFrameIndex + 1} ms</span>
            <input
              type="range"
              min="40"
              max="1000"
              step="10"
              value={activeFrame.durationMs}
              onChange={(event) => onDurationChange(activeFrameIndex, Number(event.target.value))}
            />
            <output>{activeFrame.durationMs}</output>
          </label>
          <div className="frame-actions">
            <button
              type="button"
              onClick={() => onMoveFrame(activeFrameIndex, -1)}
              disabled={activeFrameIndex === 0}
              title="Move frame earlier"
            >
              ◀
            </button>
            <button
              type="button"
              onClick={() => onMoveFrame(activeFrameIndex, 1)}
              disabled={activeFrameIndex === frames.length - 1}
              title="Move frame later"
            >
              ▶
            </button>
            <button type="button" onClick={() => onDuplicateFrame(activeFrameIndex)} title="Duplicate frame">
              Dup
            </button>
            <button
              type="button"
              onClick={() => onDeleteFrame(activeFrameIndex)}
              disabled={frames.length <= 1}
              title="Delete frame"
            >
              Del
            </button>
          </div>
          <div className="frame-export">
            <button type="button" onClick={onExportGif} disabled={isExporting} title="Export animated GIF">
              {isExporting ? "Encoding…" : "Export GIF"}
            </button>
            <button type="button" onClick={onSaveLoop} title="Save loop to Paint Space">
              Save loop
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
