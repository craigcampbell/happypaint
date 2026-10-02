// NSFW watcher, main-thread controller/glue.
//
// WHY THIS CANNOT TOUCH THE DRAWING EXPERIENCE (docs/CONTENT_MODERATION.md §0):
//   1. Inert until the server elects this client: setActive(true) is the ONLY thing
//      that starts the loop, and the host only calls it on watcher_role{active:true}
//      in a kid_safe room. Constructing the watcher does nothing on its own.
//   2. A live local stroke always wins. Before every sample we ask isDrawing()
//      (the host passes () => activePointerRef.current != null). If a stroke is in
//      progress we skip and reschedule, we never read the canvas mid-stroke.
//   3. Throttled to one sample per intervalMs (default 8000ms) AND gated by a dirty
//      flag: markDirty() must have fired (host calls it on op/stroke commit) or we
//      don't even snapshot. Scheduling uses requestIdleCallback (setTimeout fallback)
//      so the browser only wakes us in spare time.
//   4. The snapshot is a SINGLE drawImage into a tiny reused offscreen canvas
//      (<= maxDim px, default 256, longest side), then createImageBitmap (async).
//      No getImageData, no pixel loops, no synchronous work of size on the main
//      thread, pixels are read inside the worker only.
//   5. All inference is in nsfwWatcher.worker.js via OffscreenCanvas. Here we only
//      postMessage(imageBitmap, [transfer]) and receive a number back.
//   6. Capability gate: isWatcherCapable(), weak devices never scan.
//
// DETECTOR SEAM: lives in the worker (see nsfwWatcher.worker.js loadDetector). The
// controller is detector-agnostic; it just relays bitmaps and scores.

const DEFAULT_INTERVAL_MS = 8000;
const DEFAULT_MAX_DIM = 256;
const DEFAULT_THRESHOLD = 0.7;
// Evidence encoding happens entirely in the worker, only after a flag. PNG is
// the default: lossless, so the stored frame decodes to pixels bit-identical
// to what the classifier read. If the encode never comes back (worker died,
// stale generation) the flag still goes out, without pixels, after this.
const DEFAULT_EVIDENCE_TIMEOUT_MS = 2500;

/**
 * Capability gate (HARD RULE 6). A client should decline watcher election unless it
 * has the headroom to scan without affecting drawing.
 * @returns {boolean}
 */
export function isWatcherCapable() {
  if (typeof navigator === "undefined") {
    return false;
  }
  // NEVER run heavy on-device ML (TF.js + the model) on a touch-first device.
  // Phones and tablets are usually the very device someone is drawing on, and
  // inference contends with the canvas for CPU/GPU/memory, which on iOS Safari
  // shows up as dropped touches and stutter. Require a desktop-class device with
  // a fine (mouse/trackpad) primary pointer.
  if (typeof matchMedia === "function") {
    if (matchMedia("(pointer: coarse)").matches) {
      return false; // touch-primary (phone/tablet)
    }
    if (!matchMedia("(pointer: fine)").matches) {
      return false;
    }
  } else if (typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1) {
    return false; // no matchMedia, treat multi-touch as a touch device
  }
  // iPadOS Safari with a trackpad/keyboard reports a fine pointer and platform
  // "MacIntel", but it's still a tablet, exclude it explicitly.
  const platform = navigator.platform || "";
  if (/iP(hone|ad|od)/.test(platform) || /iP(hone|ad|od)/.test(navigator.userAgent || "")) {
    return false;
  }
  if (/Mac/.test(platform) && (navigator.maxTouchPoints || 0) > 1) {
    return false; // iPad masquerading as a Mac
  }
  const cores = navigator.hardwareConcurrency;
  if (typeof cores !== "number" || cores < 4) {
    return false;
  }
  const mem = navigator.deviceMemory;
  // deviceMemory is not exposed on every browser; absent => don't penalise.
  if (mem != null && mem < 4) {
    return false;
  }
  return true;
}

/**
 * Schedule a callback in idle time, falling back to setTimeout where
 * requestIdleCallback is unavailable. Returns an opaque cancel token.
 */
function scheduleIdle(fn, timeoutMs) {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(fn, { timeout: timeoutMs });
    return { type: "ric", handle };
  }
  const handle = setTimeout(fn, timeoutMs);
  return { type: "timeout", handle };
}

function cancelIdle(token) {
  if (!token) {
    return;
  }
  if (token.type === "ric" && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(token.handle);
  } else if (token.type === "timeout") {
    clearTimeout(token.handle);
  }
}

/**
 * Create the watcher controller.
 *
 * @param {object} opts
 * @param {() => (HTMLCanvasElement|OffscreenCanvas|null)} opts.getCanvas  source canvas
 * @param {() => boolean} opts.isDrawing  true while a local stroke is live (defer)
 * @param {() => number}  opts.getLastOpId  latest server opId seen by this client
 * @param {(flag:{kind:'image',score:number,sinceOpId:number,toOpId:number,evidence?:object}) => void} opts.onFlag
 * @param {number} [opts.intervalMs=8000]
 * @param {number} [opts.maxDim=256]
 * @param {number} [opts.threshold=0.7]
 * @param {'png'|'jpeg'} [opts.evidenceFormat='png']  frozen-frame encoding (png is lossless)
 * @param {number} [opts.evidenceQuality=0.92]  jpeg-only
 * @param {number} [opts.evidenceTimeoutMs=2500]  flag goes out pixel-less after this
 * @param {() => object} [opts.workerFactory]  test seam, defaults to the real Worker
 * @returns {{ setActive:(b:boolean)=>void, markDirty:()=>void, destroy:()=>void }}
 */
export function createNsfwWatcher({
  getCanvas,
  isDrawing,
  getLastOpId,
  onFlag,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxDim = DEFAULT_MAX_DIM,
  threshold = DEFAULT_THRESHOLD,
  evidenceFormat = "png",
  evidenceQuality = 0.92,
  evidenceTimeoutMs = DEFAULT_EVIDENCE_TIMEOUT_MS,
  workerFactory = null,
}) {
  let active = false;
  let destroyed = false;
  let dirty = false;
  let scanning = false;
  // True while a flagged frame's evidence encode is in flight. The scan canvas
  // inside the worker is SEALED for that frame, if we sampled again now, the
  // next scan would overwrite the exact pixels we are about to freeze. So the
  // sampling loop pauses until the encode resolves (or times out).
  let sealing = false;
  let lastSampleAt = 0;
  // The newest opId we have confirmed "clean" (score < threshold). The next flag's
  // sinceOpId is this value; toOpId is the opId at sample time. Together they
  // describe the delta that turned the canvas dirty (§5 of the contract).
  let lastCleanOpId = safeOpId();

  let idleToken = null;
  let worker = null;
  let nextMsgId = 1;
  const pending = new Map(); // msgId -> { toOpId }
  // Evidence encode follow-ups: encodeId -> { generation, timer, finish }.
  // Ids come from the same counter as scans; the maps disambiguate replies.
  const pendingEncodes = new Map();

  // A single reused offscreen snapshot canvas (the only canvas we own here).
  let snap = null;
  let snapCtx = null;

  function safeOpId() {
    try {
      const id = getLastOpId?.();
      return typeof id === "number" && id >= 0 ? id : 0;
    } catch {
      return 0;
    }
  }

  function ensureWorker() {
    if (worker || destroyed) {
      return worker;
    }
    try {
      worker = workerFactory
        ? workerFactory()
        : new Worker(
          new URL("../workers/nsfwWatcher.worker.js", import.meta.url),
          { type: "module" }
        );
      worker.onmessage = onWorkerMessage;
      worker.onerror = () => {
        // Worker death must never affect drawing; just stop scanning quietly.
        scanning = false;
      };
    } catch {
      worker = false; // sentinel: tried, unavailable on this platform
    }
    return worker || null;
  }

  function ensureSnapCanvas(w, h) {
    if (!snap) {
      // Prefer OffscreenCanvas; fall back to a detached <canvas>.
      if (typeof OffscreenCanvas === "function") {
        snap = new OffscreenCanvas(w, h);
      } else if (typeof document !== "undefined") {
        snap = document.createElement("canvas");
      } else {
        return null;
      }
      snapCtx = snap.getContext("2d");
    }
    if (snap.width !== w || snap.height !== h) {
      snap.width = w;
      snap.height = h;
    }
    return snapCtx;
  }

  function onWorkerMessage(event) {
    const msg = event.data || {};
    const { id, ok, score } = msg;
    // An encode reply shares the id counter with scans; route by map first.
    if (pendingEncodes.has(id)) {
      handleEncodeReply(msg);
      return;
    }
    const entry = pending.get(id);
    pending.delete(id);
    scanning = false;
    if (destroyed || !entry) {
      return;
    }
    if (ok && typeof score === "number") {
      if (score >= threshold) {
        const sinceOpId = lastCleanOpId;
        const toOpId = entry.toOpId;
        // Only flag if there is actually a delta to implicate.
        if (toOpId > sinceOpId) {
          // Freeze the frame BEFORE flagging: the worker still holds the exact
          // canvas the classifier read. Seal it, ask the worker to encode it,
          // and only then fire onFlag with the pixels attached.
          requestEvidenceAndFlag({ score, sinceOpId, toOpId, generation: msg.generation });
        }
        // Leave lastCleanOpId where it was, the dirty delta is still suspect until
        // a host acts. We do, however, advance past this sample so we don't refire
        // the identical delta every interval.
        lastCleanOpId = toOpId;
      } else {
        // Canvas is clean as of this sample; advance the clean watermark.
        lastCleanOpId = entry.toOpId;
      }
    }
    // Whether flagged or clean, this sample consumed the dirty state.
    // (markDirty() during the in-flight scan will have re-set `dirty`.)
    scheduleNext();
  }

  // A scan crossed the threshold. Ask the worker to encode ITS scan canvas
  // (sealed by generation, a stale answer or a mismatched generation is
  // dropped) and fire the flag once the pixels come back. If anything goes
  // wrong the flag still fires, just without evidence: moderation must never
  // depend on the encode succeeding.
  function requestEvidenceAndFlag(flag) {
    sealing = true; // pause sampling so the next scan can't overwrite the frame
    const finish = (evidence) => {
      if (destroyed) {
        return;
      }
      sealing = false;
      pendingEncodes.delete(encId);
      clearTimeout(entry.timer);
      try {
        onFlag?.({
          kind: "image",
          score: flag.score,
          sinceOpId: flag.sinceOpId,
          toOpId: flag.toOpId,
          ...(evidence ? { evidence } : {}),
        });
      } catch {
        // host callback errors are not our problem to crash on
      }
      scheduleNext(0);
    };
    const encId = nextMsgId++;
    const entry = {
      generation: flag.generation,
      timer: setTimeout(() => finish(null), evidenceTimeoutMs),
      finish,
    };
    if (typeof entry.timer.unref === "function") {
      entry.timer.unref();
    }
    pendingEncodes.set(encId, entry);
    let posted = false;
    try {
      if (worker && typeof worker.postMessage === "function") {
        worker.postMessage({
          type: "encode",
          id: encId,
          generation: flag.generation,
          format: evidenceFormat,
          quality: evidenceQuality,
        });
        posted = true;
      }
    } catch {
      posted = false;
    }
    if (!posted) {
      finish(null);
    }
  }

  function handleEncodeReply(msg) {
    const entry = pendingEncodes.get(msg.id);
    if (!entry) {
      return;
    }
    const ev = msg.ok ? msg.evidence : null;
    // Bind pixels to THIS flag only when they provably came from the same scan
    // generation the score came from, anything else could be a newer frame.
    const valid =
      ev &&
      msg.generation === entry.generation &&
      typeof ev.dataUrl === "string" &&
      Number.isFinite(ev.w) &&
      Number.isFinite(ev.h);
    entry.finish(
      valid
        ? {
            image: ev.dataUrl,
            w: ev.w,
            h: ev.h,
            model: typeof ev.model === "string" ? ev.model : null,
            threshold,
            intervalMs,
            maxDim,
            capturedAt: Date.now(),
          }
        : null
    );
  }

  // Take a downscaled snapshot and hand it to the worker. Async only because of
  // createImageBitmap; no heavy synchronous work runs on the main thread.
  async function sample() {
    if (destroyed || !active || scanning || sealing) {
      return;
    }
    // HARD RULE 2: a live stroke always wins.
    if (isDrawing?.()) {
      scheduleNext();
      return;
    }
    const source = getCanvas?.();
    if (!source || !source.width || !source.height) {
      scheduleNext();
      return;
    }
    const w = source.width;
    const h = source.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));

    const c = ensureSnapCanvas(dw, dh);
    if (!c) {
      scheduleNext();
      return;
    }

    let bitmap;
    try {
      // HARD RULE 4: a single drawImage downscale, then createImageBitmap (async).
      c.clearRect(0, 0, dw, dh);
      c.drawImage(source, 0, 0, dw, dh);
      if (typeof createImageBitmap !== "function") {
        scheduleNext();
        return;
      }
      bitmap = await createImageBitmap(snap);
    } catch {
      scheduleNext();
      return;
    }

    if (destroyed || !active) {
      try {
        bitmap.close();
      } catch {
        // ignore
      }
      return;
    }

    const w2 = ensureWorker();
    if (!w2) {
      try {
        bitmap.close();
      } catch {
        // ignore
      }
      scheduleNext();
      return;
    }

    const id = nextMsgId++;
    const toOpId = safeOpId();
    pending.set(id, { toOpId });
    scanning = true;
    lastSampleAt = now();
    dirty = false; // consumed; markDirty() can re-set it during the scan
    try {
      w2.postMessage({ id, bitmap }, [bitmap]);
    } catch {
      pending.delete(id);
      scanning = false;
      try {
        bitmap.close();
      } catch {
        // ignore
      }
      scheduleNext();
    }
  }

  function now() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  // Idle-scheduled gate: only fire a sample when active, not mid-scan, dirty, and
  // at least intervalMs since the last one. Otherwise reschedule cheaply.
  function tick() {
    idleToken = null;
    if (destroyed || !active) {
      return;
    }
    if (scanning || sealing) {
      scheduleNext();
      return;
    }
    if (!dirty) {
      scheduleNext();
      return;
    }
    const elapsed = now() - lastSampleAt;
    if (elapsed < intervalMs) {
      scheduleNext(intervalMs - elapsed);
      return;
    }
    // Fire and forget; sample() reschedules itself.
    void sample();
  }

  function scheduleNext(delayMs = intervalMs) {
    if (destroyed || !active) {
      return;
    }
    if (idleToken) {
      return; // already scheduled
    }
    idleToken = scheduleIdle(tick, Math.max(0, Math.round(delayMs)));
  }

  return {
    setActive(next) {
      const on = !!next;
      if (on === active) {
        return;
      }
      active = on;
      if (active) {
        // Reset watermark to "now" so we only judge future deltas.
        lastCleanOpId = safeOpId();
        scheduleNext(0);
      } else {
        cancelIdle(idleToken);
        idleToken = null;
      }
    },
    markDirty() {
      dirty = true;
      // If we're active and idle, make sure a tick is queued.
      if (active && !destroyed && !idleToken && !scanning) {
        scheduleNext(0);
      }
    },
    destroy() {
      destroyed = true;
      active = false;
      sealing = false;
      cancelIdle(idleToken);
      idleToken = null;
      pending.clear();
      for (const entry of pendingEncodes.values()) {
        clearTimeout(entry.timer);
      }
      pendingEncodes.clear();
      if (worker && typeof worker.terminate === "function") {
        try {
          worker.terminate();
        } catch {
          // ignore
        }
      }
      worker = null;
      snap = null;
      snapCtx = null;
    },
  };
}
