import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hexToHsv, hsvToHex, isHexColor, normalizeHex, withAlpha } from "../utils/color";

// The studio's own colour picker: a hue WHEEL (ring) with the live colour in
// its centre, then Saturation / Brightness / Opacity bars, a hex field, and
// the palette + recent swatches for one-tap picks.
//
// Perf: dragging the ring or a bar re-renders only THIS component; the
// parent (App, a 10k-line component) hears about it at most once per frame
// through a rAF-throttled onChange, and onCommit fires once, debounced, after
// the drag settles — that's the moment a swatch is added to "recent".
//
// HSB state lives here rather than being derived from the hex prop, because
// a hex loses its hue at s=0 / v=0 (white, black, greys): dragging brightness
// to black and back must return to the same hue, not snap to red.

const RING_THICKNESS = 26;
const DEFAULT_RING = 196;
const COMMIT_DEBOUNCE_MS = 350;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const pct = (n) => Math.round(clamp01(n) * 100);

function drawHueRing(canvas) {
  const size = Math.max(80, Math.round(canvas.clientWidth || DEFAULT_RING));
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const px = Math.round(size * dpr);
  if (canvas.width !== px || canvas.height !== px) {
    canvas.width = px;
    canvas.height = px;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const r = (size - RING_THICKNESS) / 2;
  ctx.lineWidth = RING_THICKNESS;
  ctx.lineCap = "butt";
  const step = Math.PI / 180;
  // 360 one-degree wedges, each overdrawn a touch so no hairline seams show at
  // any DPR. Hue 0 (red) sits at 12 o'clock and runs clockwise. (No
  // createConicGradient — older iPads lack it; this is one-off work anyway.)
  for (let deg = 0; deg < 360; deg += 1) {
    const a0 = (deg - 90) * step;
    ctx.beginPath();
    ctx.arc(c, c, r, a0, a0 + step * 1.15);
    ctx.strokeStyle = `hsl(${deg}, 100%, 50%)`;
    ctx.stroke();
  }
  return size;
}

export default function ColorWheelPicker({
  color,
  opacity = 1,
  palette = [],
  recent = [],
  onChange,
  onOpacityChange,
  onCommit,
  onClose,
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(normalizeHex(color, "#111827")));
  const [hexDraft, setHexDraft] = useState(() => normalizeHex(color, "#111827"));
  const [ringSize, setRingSize] = useState(DEFAULT_RING);
  const ringRef = useRef(null);
  const lastEmittedRef = useRef(normalizeHex(color, "#111827"));
  const rafRef = useRef(0);
  const pendingRef = useRef(null); // { hex?, opacity? } waiting for the next frame
  const commitTimerRef = useRef(0);
  const ringDragRef = useRef(null);

  const hex = useMemo(() => hsvToHex(hsv.h, hsv.s, hsv.v), [hsv]);

  // External change (a palette tap in the rail, an undo of the colour…):
  // resync unless it's the value we just emitted ourselves.
  useEffect(() => {
    const norm = normalizeHex(color, lastEmittedRef.current);
    if (norm !== lastEmittedRef.current) {
      lastEmittedRef.current = norm;
      setHsv(hexToHsv(norm));
      setHexDraft(norm);
    }
  }, [color]);

  useEffect(() => {
    const canvas = ringRef.current;
    if (!canvas) {
      return undefined;
    }
    const paint = () => setRingSize(drawHueRing(canvas));
    paint();
    window.addEventListener("resize", paint);
    return () => window.removeEventListener("resize", paint);
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current) {
        window.cancelAnimationFrame(rafRef.current);
      }
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current);
      }
    },
    [],
  );

  // Coalesce to one parent update per frame (the parent re-render is the
  // expensive part, not this component).
  const flushPending = useCallback(() => {
    rafRef.current = 0;
    const p = pendingRef.current;
    pendingRef.current = null;
    if (!p) {
      return;
    }
    if (p.hex !== undefined) {
      onChange?.(p.hex);
    }
    if (p.opacity !== undefined) {
      onOpacityChange?.(p.opacity);
    }
  }, [onChange, onOpacityChange]);

  const queue = useCallback(
    (patch) => {
      pendingRef.current = { ...(pendingRef.current || {}), ...patch };
      if (!rafRef.current) {
        rafRef.current = window.requestAnimationFrame(flushPending);
      }
    },
    [flushPending],
  );

  const scheduleCommit = useCallback(
    (nextHex) => {
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current);
      }
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = 0;
        onCommit?.(nextHex);
      }, COMMIT_DEBOUNCE_MS);
    },
    [onCommit],
  );

  const applyHsv = useCallback(
    (next) => {
      setHsv(next);
      const nextHex = hsvToHex(next.h, next.s, next.v);
      setHexDraft(nextHex);
      lastEmittedRef.current = nextHex;
      queue({ hex: nextHex });
      scheduleCommit(nextHex);
    },
    [queue, scheduleCommit],
  );

  // A swatch tap is a deliberate pick: land it now, no throttle, and commit.
  const pickHex = useCallback(
    (value) => {
      const norm = normalizeHex(value, hex);
      const next = hexToHsv(norm);
      setHsv(next);
      setHexDraft(norm);
      lastEmittedRef.current = norm;
      onChange?.(norm);
      if (commitTimerRef.current) {
        window.clearTimeout(commitTimerRef.current);
        commitTimerRef.current = 0;
      }
      onCommit?.(norm);
    },
    [hex, onChange, onCommit],
  );

  // ---- Hue ring -----------------------------------------------------------
  const hueFromPointer = (event) => {
    const rect = ringRef.current.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    return { deg: ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360, dist: Math.hypot(dx, dy) };
  };

  const onRingPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    const { deg, dist } = hueFromPointer(event);
    const outer = ringSize / 2;
    // Inside the hole = the preview disc, not the wheel; well outside = miss.
    if (dist < outer - RING_THICKNESS - 10 || dist > outer + 12) {
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* best effort */
    }
    ringDragRef.current = event.pointerId;
    applyHsv({ ...hsv, h: deg });
  };

  const onRingPointerMove = (event) => {
    if (ringDragRef.current !== event.pointerId) {
      return;
    }
    event.preventDefault();
    applyHsv({ ...hsv, h: hueFromPointer(event).deg });
  };

  const onRingPointerUp = (event) => {
    if (ringDragRef.current !== event.pointerId) {
      return;
    }
    ringDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  const onRingKeyDown = (event) => {
    const stepDeg = event.shiftKey ? 15 : 3;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      applyHsv({ ...hsv, h: (hsv.h + stepDeg) % 360 });
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      applyHsv({ ...hsv, h: (hsv.h - stepDeg + 360) % 360 });
    }
  };

  // ---- Hex field ----------------------------------------------------------
  const commitHexDraft = () => {
    if (isHexColor(hexDraft)) {
      pickHex(hexDraft);
    } else {
      setHexDraft(hex);
    }
  };

  const hueHex = hsvToHex(hsv.h, 1, 1);
  const satTrack = `linear-gradient(to right, ${hsvToHex(hsv.h, 0, hsv.v)}, ${hsvToHex(hsv.h, 1, hsv.v)})`;
  const valTrack = `linear-gradient(to right, #000000, ${hsvToHex(hsv.h, hsv.s, 1)})`;
  const alphaTrack = `linear-gradient(to right, ${withAlpha(hex, 0)}, ${withAlpha(hex, 1)}), repeating-conic-gradient(#d3d7dd 0 25%, #ffffff 0 50%) 0 0 / 14px 14px`;
  const thumbRadius = (ringSize - RING_THICKNESS) / 2;
  const recentOnly = recent.filter((c) => !palette.includes(c));

  return (
    <div className="cw" role="dialog" aria-label="Colour picker">
      <div className="cw-head">
        <span className="cw-title">Colour</span>
        <button type="button" className="cw-close" onClick={onClose} aria-label="Close colour picker">
          ✕
        </button>
      </div>

      <div className="cw-wheel-wrap">
        <canvas
          ref={ringRef}
          className="cw-wheel"
          role="slider"
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={359}
          aria-valuenow={Math.round(hsv.h) % 360}
          tabIndex={0}
          onPointerDown={onRingPointerDown}
          onPointerMove={onRingPointerMove}
          onPointerUp={onRingPointerUp}
          onPointerCancel={onRingPointerUp}
          onKeyDown={onRingKeyDown}
        />
        <span
          className="cw-hue-thumb"
          aria-hidden="true"
          style={{ transform: `translate(-50%, -50%) rotate(${hsv.h}deg) translateY(${-thumbRadius}px)`, background: hueHex }}
        />
        <div className="cw-preview" aria-hidden="true">
          <span className="cw-preview-fill" style={{ background: withAlpha(hex, opacity) }} />
          <span className="cw-preview-hex">{hex}</span>
        </div>
      </div>

      <label className="cw-row">
        <span className="cw-row-label">Saturation</span>
        <input
          type="range"
          className="cw-range"
          min="0"
          max="100"
          value={pct(hsv.s)}
          style={{ background: satTrack }}
          aria-valuetext={`${pct(hsv.s)} percent`}
          onChange={(event) => applyHsv({ ...hsv, s: Number(event.target.value) / 100 })}
        />
        <output className="cw-row-out">{pct(hsv.s)}</output>
      </label>
      <label className="cw-row">
        <span className="cw-row-label">Brightness</span>
        <input
          type="range"
          className="cw-range"
          min="0"
          max="100"
          value={pct(hsv.v)}
          style={{ background: valTrack }}
          aria-valuetext={`${pct(hsv.v)} percent`}
          onChange={(event) => applyHsv({ ...hsv, v: Number(event.target.value) / 100 })}
        />
        <output className="cw-row-out">{pct(hsv.v)}</output>
      </label>
      <label className="cw-row">
        <span className="cw-row-label">Opacity</span>
        <input
          type="range"
          className="cw-range cw-range-alpha"
          min="8"
          max="100"
          value={Math.round(clamp01(opacity) * 100)}
          style={{ background: alphaTrack }}
          aria-valuetext={`${Math.round(clamp01(opacity) * 100)} percent`}
          onChange={(event) => queue({ opacity: Number(event.target.value) / 100 })}
        />
        <output className="cw-row-out">{Math.round(clamp01(opacity) * 100)}%</output>
      </label>

      <div className="cw-hex-row">
        <label className="cw-hex">
          <span>Hex</span>
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            maxLength={7}
            value={hexDraft}
            onChange={(event) => setHexDraft(event.target.value)}
            onBlur={commitHexDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitHexDraft();
                event.currentTarget.blur();
              }
            }}
            aria-label="Hex colour"
          />
        </label>
        <button type="button" className="primary-action cw-done" onClick={onClose}>
          Done
        </button>
      </div>

      {palette.length > 0 ? (
        <div className="cw-swatches" aria-label="Palette">
          {palette.map((c) => (
            <button
              type="button"
              key={`p-${c}`}
              className={`cw-swatch${c === hex ? " is-active" : ""}`}
              style={{ background: c }}
              onClick={() => pickHex(c)}
              aria-label={`Use ${c}`}
              aria-pressed={c === hex}
            />
          ))}
        </div>
      ) : null}
      {recentOnly.length > 0 ? (
        <div className="cw-swatches cw-recent" aria-label="Recent colours">
          <span className="cw-swatches-label">Recent</span>
          {recentOnly.map((c) => (
            <button
              type="button"
              key={`r-${c}`}
              className={`cw-swatch${c === hex ? " is-active" : ""}`}
              style={{ background: c }}
              onClick={() => pickHex(c)}
              aria-label={`Use recent ${c}`}
              aria-pressed={c === hex}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
