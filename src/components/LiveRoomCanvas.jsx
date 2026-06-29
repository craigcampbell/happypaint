// A READ-ONLY live view of a public room's mural, for the homepage. Opens a
// spectator WebSocket (/ws?room=CODE&spectate=1) — the server streams the op
// history + live ops but never registers us as a user (no presence, no count,
// no draw rights). We replay ops onto a full-res offscreen canvas and blit it,
// framed to the drawn content so visitors immediately see art being made.

import { useEffect, useRef } from "react";
import { drawBrushSegment } from "../utils/brushes";
import { drawShape, drawText } from "../utils/shapes";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "../utils/layers";

// Apply one op to the full-res offscreen context (mirrors the studio's remote-op
// renderer). `lastMap` threads each stroke's previous point across op batches.
function applyOp(ctx, op, lastMap, onImage) {
  if (!op) return;
  if (op.kind === "draw") {
    const settings = op.settings || {};
    let last = lastMap.get(op.strokeId);
    for (const point of op.points || []) {
      drawBrushSegment(ctx, last || point, point, settings);
      last = point;
    }
    lastMap.set(op.strokeId, last);
  } else if (op.kind === "shape") {
    drawShape(ctx, op.tool, op.start, op.end, op.opts || {});
  } else if (op.kind === "text") {
    drawText(ctx, op.point, op.text, op.opts || {});
  } else if (op.kind === "image" && op.dataUrl) {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, op.x, op.y, op.w, op.h);
      onImage?.();
    };
    img.src = op.dataUrl;
  }
}

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

export default function LiveRoomCanvas({ roomCode, onActivity }) {
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
      offCtx.fillStyle = "#ffffff";
      offCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    };
    resetPaper();
    lastMapRef.current = new Map();

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
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, b.x, b.y, b.w, b.h, (W - dw) / 2, (H - dh) / 2, dw, dh);
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

    const connect = () => {
      if (closed) return;
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
          resetPaper();
          lastMapRef.current = new Map();
          for (const op of data.ops || []) applyOp(offCtx, op, lastMapRef.current, blit);
          boundsRef.current = boundsOf(data.ops || []);
          blit();
          onActivity?.((data.ops || []).length);
        } else if (data.type === "op") {
          applyOp(offCtx, data.op, lastMapRef.current, blit);
          blit();
        } else if (data.type === "clear") {
          resetPaper();
          lastMapRef.current = new Map();
          boundsRef.current = null;
          blit();
        }
      };
      ws.onclose = () => {
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 2500); // homepage keeps watching
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

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      window.removeEventListener("resize", onResize);
    };
  }, [roomCode, onActivity]);

  return <canvas ref={visRef} className="live-room-canvas" aria-label="Live public room artwork" />;
}
