// Skeuomorphic bottom film strip — the animation timeline. Pure presentation:
// StudioApp owns every frame/canvas mutation; this renders the reel (sprocket
// holes, cel thumbnails, projector-glow active cel), the transport controls,
// a scrub rail with a grabbable playhead, and a per-cel eyeball that hides a
// frame LOCALLY (session-only preview mute — never shared, never exported out).
//
// Evolved from the old tool-rail FrameStrip; keeps its prop contract and adds
// scrubbing + per-frame hide + the LIVE badge (cel 1 hosts the room's shared
// mural while animation stays local-only).

import { useRef, useState } from "react";

export default function FilmStrip({
  frames,
  activeFrameIndex,
  thumbnails,
  isPlaying,
  onionSkin,
  isExporting,
  hiddenFrameIds,
  liveBadge,
  maxFrames,
  onSelectFrame,
  onAddFrame,
  onDuplicateFrame,
  onDeleteFrame,
  onMoveFrame,
  onDurationChange,
  onTogglePlay,
  onToggleOnion,
  onToggleFrameHidden,
  onScrub,
  onScrubEnd,
  onExportGif,
  onSaveLoop,
}) {
  const railRef = useRef(null);
  // Visual-only scrub position; the canvas preview is painted by StudioApp
  // through onScrub. null = not scrubbing.
  const [scrubIndex, setScrubIndex] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const activeFrame = frames[activeFrameIndex];
  const multiFrame = frames.length > 1;
  const displayIndex = scrubIndex == null ? activeFrameIndex : scrubIndex;

  const indexFromEvent = (event) => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) {
      return 0;
    }
    const pct = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return Math.min(frames.length - 1, Math.floor(pct * frames.length));
  };

  const handleRailDown = (event) => {
    if (!multiFrame) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const index = indexFromEvent(event);
    setScrubIndex(index);
    onScrub(index);
  };

  const handleRailMove = (event) => {
    if (scrubIndex == null) {
      return;
    }
    const index = indexFromEvent(event);
    if (index !== scrubIndex) {
      setScrubIndex(index);
      onScrub(index);
    }
  };

  const handleRailUp = (event) => {
    if (scrubIndex == null) {
      return;
    }
    const index = indexFromEvent(event);
    setScrubIndex(null);
    onScrubEnd(index);
  };

  const closeMenuThen = (action) => (...args) => {
    setMenuOpen(false);
    action(...args);
  };

  return (
    <section className="film-strip" aria-label="Animation film strip">
      <div className="fs-transport">
        <button
          type="button"
          className="fs-onion"
          onClick={onToggleOnion}
          aria-pressed={onionSkin}
          title="Onion skin — see neighbour frames faintly"
        >
          🧅
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          disabled={!multiFrame}
          aria-pressed={isPlaying}
          title={multiFrame ? "Play / pause" : "Add a frame to preview"}
        >
          {isPlaying ? "⏸" : "▶"}
        </button>
        <span className="fs-counter" aria-live="off">
          {displayIndex + 1}/{frames.length}
        </span>
      </div>

      <div className="fs-reel" role="list">
        {frames.map((frame, index) => {
          const isActive = index === activeFrameIndex;
          const hidden = hiddenFrameIds.has(frame.id);
          return (
            <div
              key={frame.id}
              className={`fs-cel${isActive ? " is-active" : ""}${hidden ? " is-hidden" : ""}${
                scrubIndex === index ? " is-scrub" : ""
              }`}
              role="listitem"
            >
              <button
                type="button"
                className="fs-cel-thumb"
                onClick={() => onSelectFrame(index)}
                aria-pressed={isActive}
                aria-label={`Frame ${index + 1}`}
                title={`Frame ${index + 1}`}
              >
                {thumbnails[frame.id] ? <img src={thumbnails[frame.id]} alt="" /> : <span className="frame-empty" />}
                <small>{index + 1}</small>
                {liveBadge && index === 0 ? (
                  <span className="fs-live" title="Friends' strokes land on this frame">
                    LIVE
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="fs-eye"
                onClick={() => onToggleFrameHidden(frame.id)}
                aria-pressed={!hidden}
                aria-label={hidden ? `Show frame ${index + 1}` : `Hide frame ${index + 1} (only for you)`}
                title={hidden ? "Show this frame" : "Hide this frame (only for you)"}
              >
                {hidden ? "🙈" : "👁️"}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="fs-add"
          onClick={onAddFrame}
          disabled={frames.length >= maxFrames}
          title={frames.length >= maxFrames ? `Loops are capped at ${maxFrames} frames` : "Add blank frame"}
          aria-label="Add frame"
        >
          +
        </button>
      </div>

      <div className="fs-detail">
        {activeFrame ? (
          <label className="fs-duration" title="How long this frame shows">
            <input
              type="range"
              min="40"
              max="1000"
              step="10"
              value={activeFrame.durationMs}
              onChange={(event) => onDurationChange(activeFrameIndex, Number(event.target.value))}
            />
            <output>{activeFrame.durationMs}ms</output>
          </label>
        ) : null}
        <button
          type="button"
          className="fs-menu-toggle"
          onClick={() => setMenuOpen((open) => !open)}
          aria-expanded={menuOpen}
          aria-label="Frame actions"
          title="Frame actions"
        >
          ⋯
        </button>
        {menuOpen ? (
          <div className="fs-menu" role="menu">
            {/* Cel 1 (LIVE) is pinned: it hosts the room's shared mural, so it
                can't move or be deleted while animation stays local-only. */}
            <button
              type="button"
              onClick={closeMenuThen(() => onMoveFrame(activeFrameIndex, -1))}
              disabled={activeFrameIndex <= 1}
              title={activeFrameIndex === 1 ? "The LIVE frame stays first" : undefined}
            >
              ◀ Move left
            </button>
            <button
              type="button"
              onClick={closeMenuThen(() => onMoveFrame(activeFrameIndex, 1))}
              disabled={activeFrameIndex === 0 || activeFrameIndex === frames.length - 1}
              title={activeFrameIndex === 0 ? "The LIVE frame stays first" : undefined}
            >
              Move right ▶
            </button>
            <button type="button" onClick={closeMenuThen(() => onDuplicateFrame(activeFrameIndex))}>
              Duplicate
            </button>
            <button
              type="button"
              onClick={closeMenuThen(() => onDeleteFrame(activeFrameIndex))}
              disabled={frames.length <= 1 || activeFrameIndex === 0}
              title={activeFrameIndex === 0 ? "The LIVE frame can't be deleted" : undefined}
            >
              Delete
            </button>
            <button type="button" onClick={closeMenuThen(onExportGif)} disabled={isExporting}>
              {isExporting ? "Encoding…" : "Export GIF"}
            </button>
            <button type="button" onClick={closeMenuThen(onSaveLoop)}>
              Save loop
            </button>
          </div>
        ) : null}
      </div>

      <div
        className="fs-rail"
        ref={railRef}
        onPointerDown={handleRailDown}
        onPointerMove={handleRailMove}
        onPointerUp={handleRailUp}
        onPointerCancel={handleRailUp}
        role="slider"
        aria-label="Scrub through frames"
        aria-valuemin={1}
        aria-valuemax={frames.length}
        aria-valuenow={displayIndex + 1}
        tabIndex={multiFrame ? 0 : -1}
        onKeyDown={(event) => {
          if (!multiFrame) return;
          if (event.key === "ArrowLeft" && activeFrameIndex > 0) {
            onSelectFrame(activeFrameIndex - 1);
          } else if (event.key === "ArrowRight" && activeFrameIndex < frames.length - 1) {
            onSelectFrame(activeFrameIndex + 1);
          }
        }}
      >
        <div
          className="fs-needle"
          style={{ left: `${((displayIndex + 0.5) / Math.max(1, frames.length)) * 100}%` }}
        />
      </div>
    </section>
  );
}
