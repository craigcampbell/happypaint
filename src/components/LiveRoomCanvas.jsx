// A READ-ONLY live view of a public room's mural, for the homepage. Opens a
// spectator WebSocket (/ws?room=CODE&spectate=1) — the server streams the op
// history + live ops but never registers us as a user (no presence, no count,
// no draw rights). We replay ops onto a full-res offscreen canvas and blit it,
// framed to the drawn content so visitors immediately see art being made.
//
// Two display modes:
// - LIVE (default): every op repaints the visible canvas. /watch, modwatch and
//   the homepage carousel use this; nothing about it changed.
// - SNAPSHOT (snapshotIntervalMs > 0): a periodic visitor-rendered thumbnail.
//   The settled initial history paints at once, then the displayed canvas is
//   refreshed from a snapshot copy at the interval while the offscreen replay
//   keeps pace silently. Clear / history rebuilds (moderation included)
//   invalidate immediately. This is NOT a server-stored cache — each visitor
//   renders their own preview from the authoritative sanitized spectator
//   stream; client-uploaded thumbnail images are never trusted or displayed.

import { useEffect, useRef } from "react";
import { prepareStrokeCommit } from "../utils/brushes";
import { createMixMap } from "../utils/mixMap";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "../utils/layers";
// The op interpreter lives in utils/opReplay now, shared byte-for-byte with
// the production film renderer — one parity-tested replay path for both.
import { applyOp } from "../utils/opReplay";
import { orderedFrameDecoder, supportsGzipFrames } from "../utils/wsInflate";
import { sheetFullUrl } from "../utils/sheetAssets";

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

export default function LiveRoomCanvas({
  roomCode,
  onActivity,
  onSocial,
  // Moderator watch (admin "glass room"): the socket authenticates with the admin
  // key in its FIRST frame (never the URL) and is a watcher only — the server
  // drops anything that isn't a moderation action, so this view cannot paint or
  // chat even if the UI were wrong.
  modKey = null,
  onModState,
  onOps,
  onDenied,
  onSend,
  // Periodic thumbnail mode (homepage MAIN preview): when > 0, the settled
  // initial history still renders immediately, but later ops are replayed only
  // onto the offscreen paper — the VISIBLE canvas is refreshed from a snapshot
  // copy every snapshotIntervalMs instead of on every op. Clear / history
  // rebuilds (which is also how moderation hide/remove arrives) invalidate the
  // snapshot instantly, so removed art never lingers for a whole interval.
  // 0 (default) = the live view, unchanged. Modwatch is always live: the admin
  // glass room is a moderation tool, not a thumbnail.
  snapshotIntervalMs = 0,
}) {
  const visRef = useRef(null);
  const offRef = useRef(null);
  const boundsRef = useRef(null);
  const lastMapRef = useRef(new Map());

  useEffect(() => {
    if (!roomCode) return undefined;
    const snapshotMs = !modKey && snapshotIntervalMs > 0 ? snapshotIntervalMs : 0;
    // Full-res offscreen "paper" we replay ops onto.
    const off = document.createElement("canvas");
    off.width = CANVAS_WIDTH;
    off.height = CANVAS_HEIGHT;
    offRef.current = off;
    const offCtx = off.getContext("2d");
    // Snapshot mode only: the full-res copy the visible canvas is actually
    // blitted from. `off` keeps replaying ops as they arrive (the replay
    // internals stay live), but nothing reaches the screen until the interval
    // flush copies off → snap — so the displayed pixels are byte-frozen
    // between ticks, and a resize re-blit can never leak un-flushed ops.
    const snap = snapshotMs ? document.createElement("canvas") : null;
    if (snap) {
      snap.width = CANVAS_WIDTH;
      snap.height = CANVAS_HEIGHT;
    }
    const snapCtx = snap ? snap.getContext("2d") : null;
    // Dirty from the start so an empty room still paints its white placeholder
    // at the first opportunity instead of waiting for art.
    let snapDirty = true;
    const markSnapDirty = () => { snapDirty = true; };
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
      // Snapshot mode blits the frozen copy, never the live paper: a resize
      // or sheet-load re-blit must show the SAME pixels as the last tick.
      ctx.drawImage(snap || off, b.x, b.y, b.w, b.h, ox, oy, dw, dh);
      // Overlay in-progress buffered strokes (uniform stroke opacity, #62)
      // with the same world→screen mapping AND the stroke's commit composite
      // (entry.composite, from the shared entry core) so pen-up can't "pop",
      // clipped to the framed page so a buffer poking outside the crop can't
      // paint over the letterbox. Snapshot mode skips this: half-drawn live
      // strokes would leak between ticks; they appear at the first flush
      // after their end-op commits them to the paper.
      if (!snap && strokes.size > 0) {
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

    // Snapshot mode: copy the settled paper into the displayed snapshot and
    // repaint. Called on the interval tick (when dirty), and IMMEDIATELY on
    // history rebuilds / clear so removed art never survives for a whole
    // interval — the one thing a periodic cache must never do.
    const flushSnapshot = () => {
      if (!snap) return;
      snapCtx.setTransform(1, 0, 0, 1, 0, 0);
      snapCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      snapCtx.drawImage(off, 0, 0);
      snapDirty = false;
      blit();
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
        apply(sheetFullUrl(id.slice(4)));
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
      const gz = supportsGzipFrames() ? "&gz=1" : "";
      const mode = modKey ? `&modwatch=1` : `&spectate=1`;
      ws = new WebSocket(`${proto}//${window.location.host}/ws?room=${encodeURIComponent(roomCode)}${mode}${gz}`);
      ws.binaryType = "arraybuffer"; // the server's shared gzipped history frame
      const socket = ws;
      // The admin key goes in a frame, not the URL: query strings land in proxy
      // and CDN access logs, and this one is the whole account.
      ws.onopen = () => {
        if (modKey && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "mod_auth", key: modKey }));
        }
      };
      ws.onmessage = orderedFrameDecoder((text) => {
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }
        if (data.type === "history") {
          reconnectDelay = 2500; // healthy connection — reset the backoff
          resetPaper();
          mix.markAllDirty(); // the paper was rebuilt wholesale
          lastMapRef.current = new Map();
          dropStrokes(); // stale live buffers — the replay re-delivers their points
          // Snapshot mode: an inline image op's <img> can decode AFTER the
          // immediate flush below — mark dirty so the next tick picks it up.
          for (const op of data.ops || []) applyOp(offCtx, op, lastMapRef.current, strokes, snap ? markSnapDirty : blit, mix, deferred);
          commitAllStrokes(); // legacy / cut-off strokes with no end marker
          // With a sheet, show the whole page; otherwise frame to the drawn content.
          boundsRef.current = hasSheet ? null : boundsOf(data.ops || []);
          // History is a wholesale rebuild (initial catch-up, moderation
          // hide/remove, undo-clear): invalidate the snapshot NOW, not at the
          // next tick — settled art must never linger after it's gone.
          if (snap) flushSnapshot();
          else blit();
          onActivity?.((data.ops || []).length);
          if (data.ops?.length) onOps?.(data.ops);
        } else if (data.type === "op") {
          // The replay keeps pace with the room either way; only the DISPLAY
          // differs — live mode repaints per op, snapshot mode just marks the
          // paper dirty for the next tick (no continual display work).
          applyOp(offCtx, data.op, lastMapRef.current, strokes, snap ? markSnapDirty : blit, mix, deferred);
          if (snap) markSnapDirty();
          else blit();
          onOps?.([data.op]);
        } else if (data.type === "sheet") {
          loadSheet(data.sheetId);
        } else if (data.type === "clear") {
          resetPaper();
          mix.clear(); // blank paper — empty the wet-mix mirror too
          lastMapRef.current = new Map();
          dropStrokes(); // in-progress strokes are wiped with the mural
          boundsRef.current = null;
          if (snap) flushSnapshot(); // a wipe invalidates the thumbnail at once
          else blit();
        } else if (data.type === "chat" || data.type === "chat_history" || data.type === "hype") {
          // The room's live banter — the parent renders it over the viewport
          // (the conversation is the show; this canvas only paints ops).
          onSocial?.(data);
        } else if (data.type === "mod_denied") {
          // Wrong key, no such room, too many watchers: stop — retrying would
          // just hammer the server with a key that isn't going to start working.
          closed = true;
          if (reconnectTimer) window.clearTimeout(reconnectTimer);
          onDenied?.(data.reason || "denied");
          try {
            socket.close();
          } catch {
            /* ignore */
          }
        } else if (data.type === "room_closed") {
          closed = true;
          onDenied?.("room_closed");
        } else if (data.type === "connected") {
          onModState?.({ room: data });
        } else if (data.type === "userList" && Array.isArray(data.users)) {
          onModState?.({ users: data.users });
        } else if (data.type === "mod_log") {
          onModState?.({ modLog: data.entries || [] });
        } else if (data.type === "mod_alert") {
          onModState?.({ alert: data });
        } else if (data.type === "room_state" || data.type === "room_renamed") {
          onModState?.({ roomState: data });
        }
      }, () => !closed && ws === socket);
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
    // Hand the parent a way to send moderation actions over this socket. Only the
    // action types the server's watcher allowlist accepts (clear, mod_hide,
    // mod_restore, mod_remove, kick, mute, lock/unlock) reach a room from here.
    const sendControl = (message) => {
      try {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
      } catch {
        /* ignore */
      }
    };
    onSend?.(sendControl);
    connect();

    // Coming back to a tab whose socket died while hidden: reconnect right away.
    // Snapshot mode also catches up the thumbnail — ticks were skipped while
    // the tab was hidden (and browsers throttle the timer anyway).
    const onVisibility = () => {
      if (closed || document.hidden) return;
      if (snap && snapDirty) flushSnapshot();
      if (reconnectTimer) return;
      if (!ws || ws.readyState === WebSocket.CLOSED) connect();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Snapshot mode: the ONE periodic refresh. Skips hidden tabs (no one is
    // looking — the visibility handler catches up on return) and idle stretches
    // with no new ops (an empty room just keeps showing its placeholder).
    const snapTimer = snap
      ? window.setInterval(() => {
          if (document.hidden || !snapDirty) return;
          flushSnapshot();
        }, snapshotMs)
      : null;

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
      if (committed) {
        if (snap) markSnapDirty(); // settled ink joins the next tick
        else blit();
      }
    }, 2000);

    return () => {
      closed = true;
      window.clearInterval(sweep);
      if (snapTimer) window.clearInterval(snapTimer);
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
  }, [roomCode, modKey, snapshotIntervalMs, onActivity, onSocial, onModState, onOps, onDenied, onSend]);

  return <canvas ref={visRef} className="live-room-canvas" aria-label="Live public room artwork" />;
}
