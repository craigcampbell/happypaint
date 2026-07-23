// Room Replay player — a modal that loads the captured snapshot series and
// plays it back as a flipbook: play/pause, a scrubber over the keyframes, a
// speed control, "Remix from here" (restores the selected snapshot as a new
// single-layer artwork via the existing restore path), and "Export timelapse"
// (encodes the snapshots into a GIF via the existing worker-based encoder).
//
// This is SNAPSHOT-BASED, not stroke-based: each frame is a rendered downscaled
// composite Blob, so playback is just blitting images in sequence.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SPEEDS = [
  { label: "0.5x", fps: 4 },
  { label: "1x", fps: 8 },
  { label: "2x", fps: 16 },
  { label: "4x", fps: 32 },
];

export default function ReplayPlayer({
  snapshots,
  onClose,
  onRemixFromHere,
  onShareTimelapse,
  onExportTimelapse,
  onSaveTimelapse,
  isExporting,
}) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const lastTickRef = useRef(0);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1);

  // Decode every snapshot Blob into an Image once. Object URLs are revoked on
  // unmount / when the snapshot set changes.
  const [images, setImages] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const urls = [];
    const loaders = (snapshots || []).map(
      (snap) =>
        new Promise((resolve) => {
          if (!snap.blob) {
            resolve(null);
            return;
          }
          const url = URL.createObjectURL(snap.blob);
          urls.push(url);
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => resolve(null);
          image.src = url;
        }),
    );
    Promise.all(loaders).then((loaded) => {
      if (!cancelled) {
        setImages(loaded.filter(Boolean));
      }
    });
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [snapshots]);

  const count = images.length;
  const fps = SPEEDS[speedIndex].fps;

  // Draw a frame index onto the preview canvas.
  const drawFrame = useCallback(
    (frameIndex) => {
      const canvas = canvasRef.current;
      const image = images[frameIndex];
      if (!canvas || !image) {
        return;
      }
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    },
    [images],
  );

  useEffect(() => {
    drawFrame(index);
  }, [drawFrame, index]);

  // rAF playback loop advancing at the selected fps.
  useEffect(() => {
    if (!isPlaying || count === 0) {
      return undefined;
    }
    const frameMs = 1000 / fps;
    const step = (timestamp) => {
      if (!lastTickRef.current) {
        lastTickRef.current = timestamp;
      }
      const elapsed = timestamp - lastTickRef.current;
      if (elapsed >= frameMs) {
        lastTickRef.current = timestamp;
        setIndex((current) => {
          const next = current + 1;
          if (next >= count) {
            setIsPlaying(false);
            return count - 1;
          }
          return next;
        });
      }
      rafRef.current = window.requestAnimationFrame(step);
    };
    rafRef.current = window.requestAnimationFrame(step);
    return () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      lastTickRef.current = 0;
    };
  }, [isPlaying, fps, count]);

  const togglePlay = useCallback(() => {
    if (count === 0) {
      return;
    }
    setIsPlaying((playing) => {
      // Restart from the top if we're at the end.
      if (!playing && index >= count - 1) {
        setIndex(0);
      }
      return !playing;
    });
  }, [count, index]);

  const selectedSnapshot = useMemo(() => (snapshots || [])[index], [snapshots, index]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="studio-modal replay-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="replay-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title-row">
          <h2 id="replay-title">Replay &amp; Timelapse</h2>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>

        {count === 0 ? (
          <div className="empty-gallery ps-empty">
            No replay snapshots yet. Keep drawing — snapshots are captured automatically while you paint.
          </div>
        ) : (
          <>
            <p className="ps-subtitle">
              {count} snapshot{count === 1 ? "" : "s"} of your process. Snapshot-based replay (not stroke-by-stroke).
            </p>

            <div className="replay-stage">
              <canvas ref={canvasRef} width={480} height={360} className="replay-canvas" aria-label="Replay frame" />
            </div>

            <div className="replay-controls">
              <button type="button" className="primary-action" onClick={togglePlay}>
                {isPlaying ? "Pause" : "Play"}
              </button>
              <input
                type="range"
                className="replay-scrubber"
                min="0"
                max={Math.max(0, count - 1)}
                value={index}
                onChange={(event) => {
                  setIsPlaying(false);
                  setIndex(Number(event.target.value));
                }}
                aria-label="Scrub through snapshots"
              />
              <output className="replay-counter">
                {index + 1}/{count}
              </output>
            </div>

            <div className="replay-speed" role="group" aria-label="Playback speed">
              <span>Speed</span>
              {SPEEDS.map((speed, speedIdx) => (
                <button
                  type="button"
                  key={speed.label}
                  className={`brush-chip ${speedIndex === speedIdx ? "is-active" : ""}`}
                  onClick={() => setSpeedIndex(speedIdx)}
                  aria-pressed={speedIndex === speedIdx}
                >
                  <span>{speed.label}</span>
                </button>
              ))}
            </div>

            <div className="replay-actions">
              {onShareTimelapse ? (
                <button
                  type="button"
                  className="replay-share primary-action"
                  onClick={() => onShareTimelapse()}
                  disabled={isExporting}
                  title="Share the watch-it-draw GIF"
                >
                  {isExporting ? "Making it…" : "📤 Share my timelapse"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onRemixFromHere?.(selectedSnapshot)}
                title="Restore this snapshot as a new artwork"
              >
                Remix from here
              </button>
              <button
                type="button"
                onClick={() => onExportTimelapse?.()}
                disabled={isExporting}
                title="Encode the snapshots into a GIF timelapse"
              >
                {isExporting ? "Encoding…" : "Save GIF"}
              </button>
              <button
                type="button"
                onClick={() => onSaveTimelapse?.()}
                disabled={isExporting}
                title="Save the timelapse to your Paint Space"
              >
                Save to Paint Space
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
