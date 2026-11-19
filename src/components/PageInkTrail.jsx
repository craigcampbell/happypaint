import { useEffect, useRef } from "react";
import "./page-ink-trail.css";

const PENCIL = "#d94329";
const TRAIL_MS = 1850;
const HOLD_MS = 10000;
const FADE_MS = 2000;
const MAX_PATHS = 64;
const POINTS_PER_PATH = 192;
const MAX_TRAIL = 220;
const EXEMPT = "input, textarea, select, [contenteditable]:not([contenteditable=false]), [data-ink-ui], [data-no-ink], .studio-shell, canvas, iframe, video";

// The hover trail evaporates from its oldest end. Draw adjacent segments of
// matching opacity together so fast curves stay continuous at the joins.
function drawTrail(ctx, points, now) {
  let group = -1;
  let tint = "";
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    if (to.start) { group = -1; continue; }
    const life = 1 - (now - to.time) / TRAIL_MS;
    const band = Math.max(1, Math.min(12, Math.ceil(life * 12)));
    const endOfGroup = i === points.length - 1 || points[i + 1].start;
    if (group !== band || tint !== to.color) {
      if (group !== -1) ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.strokeStyle = to.color;
      ctx.globalAlpha = 0.82 * band / 12;
      ctx.lineWidth = 0.5 + band / 12;
      group = band;
      tint = to.color;
    }
    ctx.lineTo(to.x, to.y);
    if (endOfGroup) { ctx.stroke(); group = -1; }
  }
}

export default function PageInkTrail({ color = PENCIL, drawing = false, clearKey = 0 }) {
  const canvasRef = useRef(null);
  const tool = useRef({ color: PENCIL, drawing });

  useEffect(() => {
    tool.current = { color: getComputedStyle(canvasRef.current).color, drawing };
  }, [color, drawing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let strokes = [];
    let trail = [];
    let pen = null;
    let dragControl = null;
    let breakTrail = true;
    let frame = 0;
    let timer = 0;

    function requestPaint() {
      window.clearTimeout(timer);
      timer = 0;
      if (!frame && !document.hidden) frame = window.requestAnimationFrame(paint);
    }

    function paint(now) {
      frame = 0;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(canvas.clientWidth * ratio);
      const height = Math.round(canvas.clientHeight * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.setTransform(ratio, 0, 0, ratio, -window.scrollX * ratio, -window.scrollY * ratio);
      ctx.lineCap = ctx.lineJoin = "round";
      let nextFade = Infinity;
      let fading = false;
      strokes = strokes.filter(stroke => stroke.fadeAt + FADE_MS > now);
      for (const stroke of strokes) {
        const remaining = stroke.fadeAt - now;
        if (remaining > 0) nextFade = Math.min(nextFade, remaining);
        else fading = true;
        ctx.globalAlpha = 0.94 * Math.min(1, 1 + remaining / FADE_MS);
        ctx.strokeStyle = ctx.fillStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        if (stroke.count === 1) {
          ctx.beginPath();
          ctx.arc(stroke.x, stroke.y, stroke.width * 0.65, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.stroke(stroke.path);
        }
      }
      trail = trail.filter(point => now - point.time < TRAIL_MS);
      drawTrail(ctx, trail, now);
      if (trail.length || fading) requestPaint();
      else if (Number.isFinite(nextFade)) timer = window.setTimeout(requestPaint, Math.ceil(nextFade));
    }

    function beginStroke(event, point, color = tool.current.color) {
      const stroke = {
        path: new Path2D(), color, width: event.pointerType === "pen" ? 2.15 : 2.4,
        count: 1, x: point.pageX, y: point.pageY, fadeAt: Infinity,
      };
      stroke.path.moveTo(stroke.x, stroke.y);
      strokes.push(stroke);
      if (strokes.length > MAX_PATHS) strokes.shift();
      return stroke;
    }

    function finishStroke() {
      if (!pen) return;
      pen.stroke.path.lineTo(pen.stroke.x, pen.stroke.y);
      if (!pen.keep) {
        const fadeAt = performance.now() + HOLD_MS;
        for (const path of pen.paths) path.fadeAt = fadeAt;
      }
      pen = null;
      requestPaint();
    }

    function append(event, point) {
      const x = point.pageX;
      const y = point.pageY;
      if (pen) {
        let stroke = pen.stroke;
        if (Math.hypot(x - stroke.x, y - stroke.y) < 1.25) return;
        if (stroke.count >= POINTS_PER_PATH) {
          stroke.path.lineTo(stroke.x, stroke.y);
          stroke = beginStroke(event, { pageX: stroke.x, pageY: stroke.y }, stroke.color);
          pen.stroke = stroke;
          pen.paths.push(stroke);
          if (pen.paths.length > MAX_PATHS) pen.paths.shift();
        }
        stroke.path.quadraticCurveTo(stroke.x, stroke.y, (stroke.x + x) / 2, (stroke.y + y) / 2);
        stroke.x = x;
        stroke.y = y;
        stroke.count++;
      } else {
        const last = trail[trail.length - 1];
        const distance = last ? Math.hypot(x - last.x, y - last.y) : 0;
        if (last && !breakTrail && distance < 1.5) return;
        const time = performance.now();
        const start = breakTrail || !last || time - last.time > 180 || distance > 220 || last.color !== tool.current.color;
        trail.push({ x, y, time, start, color: tool.current.color });
        if (trail.length > MAX_TRAIL) trail.shift();
        breakTrail = false;
      }
      requestPaint();
    }

    function exempt(event) {
      return !(event.target instanceof Element) || event.target.closest(EXEMPT);
    }

    // A stroke can start on a link. Only a deliberate drag in drawing mode
    // consumes its click. Taps, keyboard activation, and the ink tools work normally.
    function down(event) {
      if (event.isPrimary) dragControl = null;
      if (!event.isPrimary || event.button !== 0 || exempt(event) || (reduced.matches && !tool.current.drawing)) return;
      finishStroke();
      breakTrail = true;
      const target = event.target.closest?.('a[href], button, [role="button"]');
      if (tool.current.drawing && target) dragControl = { target, id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      const stroke = beginStroke(event, event);
      pen = { id: event.pointerId, stroke, paths: [stroke], keep: tool.current.drawing };
      requestPaint();
    }

    function move(event) {
      if (!event.isPrimary) return;
      if (dragControl?.id === event.pointerId && event.buttons && Math.hypot(event.clientX - dragControl.x, event.clientY - dragControl.y) > 7) dragControl.moved = true;
      if (exempt(event)) { finishStroke(); breakTrail = true; return; }
      if (pen && pen.id !== event.pointerId) return;
      if (!pen && (event.pointerType === "touch" || event.buttons !== 0 || reduced.matches)) return;
      const samples = event.getCoalescedEvents?.();
      if (samples?.length) {
        for (const point of samples) append(event, point);
      }
      append(event, event);
    }

    function up(event) {
      if (pen?.id !== event.pointerId) return;
      if (!exempt(event)) append(event, event);
      finishStroke();
      breakTrail = true;
    }

    function cancel(event) {
      if (pen?.id === event.pointerId) {
        // The browser claimed this touch for scrolling or pinch zoom.
        if (event.pointerType === "touch" && !pen.keep) strokes = strokes.filter(path => !pen.paths.includes(path));
        finishStroke();
      }
      breakTrail = true;
    }

    function leave(event) {
      if (!event.relatedTarget) { finishStroke(); breakTrail = true; }
    }

    function reposition() {
      breakTrail = true;
      if (trail.length || strokes.length) requestPaint();
    }

    function suspend() {
      finishStroke();
      breakTrail = true;
      trail = [];
      if (document.hidden) {
        window.clearTimeout(timer);
        window.cancelAnimationFrame(frame);
        frame = timer = 0;
      } else if (canvas.width > 1) requestPaint();
    }

    function motionChanged() {
      if (reduced.matches) {
        finishStroke();
        trail = [];
        strokes = strokes.filter(stroke => stroke.fadeAt === Infinity);
        if (canvas.width > 1) requestPaint();
      }
    }

    function guardClick(event) {
      const moved = event.detail > 0 && dragControl?.moved && dragControl.target.contains(event.target);
      dragControl = null;
      if (moved) { event.preventDefault(); event.stopPropagation(); }
    }

    function guardNativeDrag(event) {
      if (tool.current.drawing && !exempt(event) && event.target.closest?.('a, img')) event.preventDefault();
    }

    document.addEventListener("click", guardClick, true);
    document.addEventListener("dragstart", guardNativeDrag, true);
    const passive = { capture: true, passive: true };
    const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: cancel, pointerout: leave };
    for (const [name, handler] of Object.entries(events)) document.addEventListener(name, handler, passive);
    document.addEventListener("visibilitychange", suspend);
    window.addEventListener("blur", suspend);
    window.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("resize", reposition);
    reduced.addEventListener("change", motionChanged);
    return () => {
      document.removeEventListener("click", guardClick, true);
      document.removeEventListener("dragstart", guardNativeDrag, true);
      for (const [name, handler] of Object.entries(events)) document.removeEventListener(name, handler, true);
      document.removeEventListener("visibilitychange", suspend);
      window.removeEventListener("blur", suspend);
      window.removeEventListener("scroll", reposition);
      window.removeEventListener("resize", reposition);
      reduced.removeEventListener("change", motionChanged);
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      canvas.width = canvas.height = 1;
    };
  }, [clearKey]);

  return <canvas className="page-ink-trail" data-page-ink="" aria-hidden="true" width="1" height="1" ref={canvasRef} style={{ color }} />;
}
