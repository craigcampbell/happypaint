// A READ-ONLY live view of a public room's mural, for the homepage. Opens a
// spectator WebSocket (/ws?room=CODE&spectate=1) — the server streams the op
// history + live ops but never registers us as a user (no presence, no count,
// no draw rights). We replay ops onto a full-res offscreen canvas and blit it,
// framed to the drawn content so visitors immediately see art being made.

import { useEffect, useRef } from "react";
import { prepareStrokeCommit } from "../utils/brushes";
import { createMixMap } from "../utils/mixMap";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "../utils/layers";
// The op interpreter lives in utils/opReplay now, shared byte-for-byte with
// the production film renderer — one parity-tested replay path for both.
import { applyOp } from "../utils/opReplay";

// Strokes whose end-op never arrives are committed by the idle sweep after this long.
const STROKE_IDLE_MS = 8000;

// Bounding box of drawn content (world coords), padded, clamped to the page —
// so we frame the preview on the art instead of the whole empty mural.
function boundsOf(ops) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  const ext = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    any = true;
  };
  for (const op of ops) {
    if (op.kind === "draw") for (const p of op.points || []) ext(p.x, p.y);
    else if (op.kind === "shape") {
      if (op.start) ext(op.start.x, op.start.y);
      if (op.end) ext(op.end.x, op.end.y);
    } else if (op.kind === "text" && op.point) ext(op.point.x, op.point.y);
    else if (op.kind === "image") {
      ext(op.x, op.y);
      ext(op.x + op.w, op.y + op.h);
    }
  }
  if (!any) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  const padX = Math.max(60, w * 0.14);
  const padY = Math.max(60, h * 0.14);
  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);
  return {
    x,
    y,
    w: Math.min(CANVAS_WIDTH - x, Math.max(240, w + padX * 2)),
    h: Math.min(CANVAS_HEIGHT - y, Math.max(240, h + padY * 2)),
  };
}

export default function LiveRoomCanvas({ roomCode, onActivity, onSocial }) {
  const visRef = useRef(null);
  const offRef = useRef(null);
  const boundsRef = useRef(null);
  const lastMapRef = useRef(new Map());

  useEffect(() => {
    if (!roomCode) return undefined;
    // Full-res offscreen "paper" we replay ops onto.
    const off = document.createElement("canvas");
    off.width = CANVAS_WIDTH;
    off.height = CANVAS_HEIGHT;
    offRef.current = off;
    const offCtx = off.getContext("2d");
    const resetPaper = () => {
      offCtx.setTransform(1, 0, 0, 1, 0, 0);
      offCtx.globalCompositeOperation = "source-over";
      offCtx.globalAlpha = 1;
      // TRANSPARENT like the studio's layer 0 (blit paints the white page):
      // visually identical (source-over is associative; eraser cuts to
      // transparent either way), and it keeps the wet-canvas mix map's
      // "transparent = nothing to pick up" reads consistent across consumers.
      offCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    };
    resetPaper();
    lastMapRef.current = new Map();

    // Wet-canvas mix map: the spectator's own 1/8-scale mirror of the off
    // canvas (its "layer 0"), sampled by wet strokes during replay/live ops.
    // Lazy inside: no pixels are read until a wet dab actually samples.
    const mix = createMixMap(() => off, CANVAS_WIDTH, CANVAS_HEIGHT);

    // In-progress stroke buffers (strokeId -> entry), per room connection.
    const strokes = new Map();
    const deferred = new Map();
    const dropStrokes = () => {
      for (const entry of strokes.values()) entry.buf?.dispose();
      strokes.clear();
      deferred.clear();
    };
    // Commit every still-open stroke to the paper (history replay leaves
    // legacy strokes — ops with no end marker — open).
    const commitAllStrokes = () => {
      for (const [id, entry] of strokes) {
        if (entry.buf) {
          prepareStrokeCommit(entry.buf, entry.renderer, entry.fx);
          entry.buf.commit(offCtx, entry.opacity);
          mix.markDirty(entry.buf.bounds());
          entry.buf.dispose();
        }
        strokes.delete(id);
      }
    };

    // The room's coloring-sheet line art (loaded on the `sheet` message), drawn
    // over the strokes so colorings show the page they're colouring.
    let sheetImg = null;
    let sheetRect = null;
    let hasSheet = false;

    const sizeVisible = () => {
      const vis = visRef.current;
      if (!vis) return;
      const rect = vis.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      vis.width = Math.max(1, Math.round(rect.width * dpr));
      vis.height = Math.max(1, Math.round(rect.height * dpr));
    };

    const blit = () => {
      const vis = visRef.current;
      if (!vis) return;
      const ctx = vis.getContext("2d");
      const W = vis.width;
      const H = vis.height;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      const b = boundsRef.current || { x: 0, y: 0, w: CANVAS_WIDTH, h: CANVAS_HEIGHT };
      const scale = Math.min(W / b.w, H / b.h);
      const dw = b.w * scale;
      const dh = b.h * scale;
      const ox = (W - dw) / 2;
      const oy = (H - dh) / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, b.x, b.y, b.w, b.h, ox, oy, dw, dh);
      // Overlay in-progress buffered strokes (uniform stroke opacity, #62)
      // with the same world→screen mapping AND the stroke's commit composite
      // (entry.composite, from the shared entry core) so pen-up can't "pop",
      // clipped to the framed page so a buffer poking outside the crop can't
      // paint over the letterbox.
      if (strokes.size > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, dw, dh);
        ctx.clip();
        for (const entry of strokes.values()) {
          if (entry.buf && entry.buf.has()) {
            const s = entry.buf;
            ctx.globalAlpha = entry.opacity;
            ctx.globalCompositeOperation = entry.composite || "source-over";
            ctx.drawImage(s.canvas, ox + (s.x0 - b.x) * scale, oy + (s.y0 - b.y) * scale, s.w * scale, s.h * scale);
            ctx.globalCompositeOperation = "source-over";
          }
        }
        ctx.restore();
      }
      // Overlay the coloring sheet using the same world→screen mapping as the mural.
      if (sheetImg && sheetRect) {
        ctx.drawImage(
          sheetImg,
          ox + (sheetRect.x - b.x) * scale,
          oy + (sheetRect.y - b.y) * scale,
          sheetRect.w * scale,
          sheetRect.h * scale,
        );
      }
    };

    // Resolve + load the room's coloring sheet (lib:<file> → static PNG; else the
    // /api/sheets data URL), then reframe to the whole page so it shows in full.
    const loadSheet = (id) => {
      if (!id) {
        sheetImg = null;
        sheetRect = null;
        hasSheet = false;
        blit();
        return;
      }
      hasSheet = true;
      boundsRef.current = null;
      const apply = (src) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const s = Math.min(CANVAS_WIDTH / img.width, CANVAS_HEIGHT / img.height);
          const w = img.width * s;
          const h = img.height * s;
          sheetRect = { x: (CANVAS_WIDTH - w) / 2, y: (CANVAS_HEIGHT - h) / 2, w, h };
          sheetImg = img;
          blit();
        };
        img.src = src;
      };
      if (id.startsWith("lib:")) {
        apply(`/coloring-sheets/full/${encodeURIComponent(id.slice(4))}.png`);
        return;
      }
      fetch(`/api/sheets/${id}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d?.image) apply(d.image); })
        .catch(() => {});
    };

    const onResize = () => {
      sizeVisible();
      blit();
    };
    sizeVisible();
    blit();
    window.addEventListener("resize", onResize);

    let ws = null;
    let closed = false;
    let reconnectTimer = null;
    let reconnectDelay = 2500; // exponential backoff; reset once history arrives

    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      // Hidden tab: don't retry at all — visibilitychange reconnects us below.
      if (document.hidden) return;
      reconnectTimer = window.setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };

    const connect = () => {
      if (closed) return;
      reconnectTimer = null;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws?room=${encodeURIComponent(roomCode)}&spectate=1`);
      ws.onmessage = (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === "history") {
          reconnectDelay = 2500; // healthy connection — reset the backoff
          resetPaper();
          mix.markAllDirty(); // the paper was rebuilt wholesale
          lastMapRef.current = new Map();
          dropStrokes(); // stale live buffers — the replay re-delivers their points
          for (const op of data.ops || []) applyOp(offCtx, op, lastMapRef.current, strokes, blit, mix, deferred);
          commitAllStrokes(); // legacy / cut-off strokes with no end marker
          // With a sheet, show the whole page; otherwise frame to the drawn content.
          boundsRef.current = hasSheet ? null : boundsOf(data.ops || []);
          blit();
          onActivity?.((data.ops || []).length);
        } else if (data.type === "op") {
          applyOp(offCtx, data.op, lastMapRef.current, strokes, blit, mix, deferred);
          blit();
        } else if (data.type === "sheet") {
          loadSheet(data.sheetId);
        } else if (data.type === "clear") {
          resetPaper();
          mix.clear(); // blank paper — empty the wet-mix mirror too
          lastMapRef.current = new Map();
          dropStrokes(); // in-progress strokes are wiped with the mural
          boundsRef.current = null;
          blit();
        } else if (data.type === "chat" || data.type === "chat_history" || data.type === "hype") {
          // The room's live banter — the parent renders it over the viewport
          // (the conversation is the show; this canvas only paints ops).
          onSocial?.(data);
        }
      };
      ws.onclose = () => {
        if (closed) return;
        scheduleReconnect(); // homepage keeps watching
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };
    connect();

    // Coming back to a tab whose socket died while hidden: reconnect right away.
    const onVisibility = () => {
      if (closed || document.hidden || reconnectTimer) return;
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Idle sweep: commit strokes whose end-op never arrived (dropped socket /
    // legacy client) so they don't hover un-inked forever. Cheap size check
    // when nobody is drawing; cleared with the room connection below.
    const sweep = window.setInterval(() => {
      if (strokes.size === 0) return;
      const now = Date.now();
      let committed = false;
      for (const [id, entry] of strokes) {
        if (now - entry.lastTouch > STROKE_IDLE_MS) {
          if (entry.buf) {
            prepareStrokeCommit(entry.buf, entry.renderer, entry.fx);
            entry.buf.commit(offCtx, entry.opacity);
            mix.markDirty(entry.buf.bounds());
            entry.buf.dispose();
          }
          strokes.delete(id);
          lastMapRef.current.delete(id);
          committed = true;
        }
      }
      if (committed) blit();
    }, 2000);

    return () => {
      closed = true;
      window.clearInterval(sweep);
      dropStrokes();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      window.removeEventListener("resize", onResize);
    };
  }, [roomCode, onActivity, onSocial]);

  return <canvas ref={visRef} className="live-room-canvas" aria-label="Live public room artwork" />;
}
