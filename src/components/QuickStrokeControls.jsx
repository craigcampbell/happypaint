import { useRef } from "react";
import { luma, withAlpha } from "../utils/color";
import { BRUSH_SIZE_MAX, BRUSH_SIZE_MIN } from "./BrushQuickMenu";

// The two "quick stroke" items on the bottom bar (and the desktop zoom
// cluster): a Size pill you DRAG to resize / TAP for the brush menu, and a
// Colour dot that opens the studio's own picker.
//
// Size drag: multiplicative, so small brushes get fine control and big ones
// move fast — every 60px of drag (right or up = bigger, left or down =
// smaller) doubles / halves the size. A press that moves < 6px is a tap.
// The pill never touches the canvas hot path: it only calls onSizeChange
// when the rounded size actually changes.

const TAP_SLOP_PX = 6;
const DOUBLE_EVERY_PX = 60;

const clampSize = (n) => Math.min(BRUSH_SIZE_MAX, Math.max(BRUSH_SIZE_MIN, Math.round(n)));

function sizeFromDrag(startSize, dx, dy) {
  return clampSize(startSize * Math.pow(2, (dx - dy) / DOUBLE_EVERY_PX));
}

// Dot diameter inside the 28px well: 6px for the thinnest brush, 26px for the fattest.
function sizeDotPx(size) {
  const t = (clampSize(size) - BRUSH_SIZE_MIN) / (BRUSH_SIZE_MAX - BRUSH_SIZE_MIN);
  return 6 + Math.round(t * 20);
}

export function SizePill({ size, color, noColor, active, className = "", showLabel = true, onSizeChange, onTap }) {
  const dragRef = useRef(null);

  const onPointerDown = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }
    event.preventDefault(); // no text selection / focus ring flash on press
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* best effort */
    }
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: size, last: size, dragging: false };
  };

  const onPointerMove = (event) => {
    const d = dragRef.current;
    if (!d || d.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < TAP_SLOP_PX) {
        return;
      }
      d.dragging = true;
    }
    event.preventDefault();
    const next = sizeFromDrag(d.start, dx, dy);
    if (next !== d.last) {
      d.last = next;
      onSizeChange?.(next);
    }
  };

  const endDrag = (event, tapped) => {
    const d = dragRef.current;
    if (!d || d.id !== event.pointerId) {
      return;
    }
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    if (tapped && !d.dragging) {
      onTap?.();
    }
  };

  const onKeyDown = (event) => {
    switch (event.key) {
      case "Enter":
      case " ":
        event.preventDefault();
        onTap?.();
        break;
      case "ArrowUp":
      case "ArrowRight":
        event.preventDefault();
        onSizeChange?.(clampSize(Math.max(size + 1, size * 1.18)));
        break;
      case "ArrowDown":
      case "ArrowLeft":
        event.preventDefault();
        onSizeChange?.(clampSize(Math.min(size - 1, size * 0.85)));
        break;
      default:
        break;
    }
  };

  const dot = sizeDotPx(size);
  return (
    <button
      type="button"
      className={`qs-size${active ? " is-active" : ""}${className ? ` ${className}` : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onKeyDown={onKeyDown}
      aria-label={`Brush size ${size}. Drag to change, press for brushes`}
      aria-pressed={active}
      title="Drag to change the size · tap to pick a brush"
    >
      <span className="qs-well" aria-hidden="true">
        <span
          className={`qs-size-dot${noColor ? " is-nocolor" : ""}`}
          style={{ width: dot, height: dot, background: noColor ? undefined : color }}
        />
      </span>
      {showLabel ? <span className="qb-label qs-size-num">{size}</span> : null}
    </button>
  );
}

export function ColorDot({ color, opacity = 1, noColor, active, className = "", showLabel = true, onTap }) {
  const dark = luma(color) < 0.45;
  return (
    <button
      type="button"
      className={`qs-color${active ? " is-active" : ""}${noColor ? " is-nocolor" : ""}${className ? ` ${className}` : ""}`}
      onClick={onTap}
      aria-label={`Colour ${color}, ${Math.round(opacity * 100)} percent opacity. Press to change`}
      aria-pressed={active}
      title="Pick a colour"
    >
      <span className={`qs-well qs-color-well${dark ? " is-dark" : ""}`} aria-hidden="true">
        <span className="qs-color-fill" style={{ background: withAlpha(color, opacity) }} />
      </span>
      {showLabel ? <span className="qb-label">Color</span> : null}
    </button>
  );
}
