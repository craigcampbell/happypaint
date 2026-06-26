// Room Replay & Timelapse — SNAPSHOT-BASED process capture (not per-stroke).
//
// Design rationale (docs/product-research.md §"Room Replay and Timelapse"):
//   - We capture downscaled COMPOSITED snapshots of the artwork over time, NOT a
//     stroke stream. This keeps storage bounded, is correct regardless of how
//     complex/expensive the strokes are or how many painters touch the canvas,
//     and reuses the existing GIF encoder for the timelapse export.
//   - Snapshots are taken on a cadence (every few seconds *while the canvas is
//     dirty*) AND on meaningful events (stroke-batch end, layer add/delete,
//     frame change). Idle time never spams snapshots (the recorder is debounced
//     and only fires when something actually changed).
//   - Temporal decimation: total keyframes are capped (~80). When the cap is
//     exceeded we drop every other snapshot in the OLDEST portion of the series,
//     halving its density so a long session stays bounded yet watchable.
//
// Storage: snapshots are stored as PNG Blobs in the existing IndexedDB "kv"
// store (idb.js), keyed per artwork. The persisted record mirrors the backend
// `replay_snapshots` table shape (seq, captured_at, kind, width, height,
// change_score) so it is sync-ready.

import { idbGetKV, idbSetKV, idbDeleteKV, isIdbAvailable } from "./idb";

// Downscaled snapshot size — small enough that 80 of them is a few MB of PNG,
// and a good source resolution for the GIF timelapse (which downscales further).
export const SNAPSHOT_WIDTH = 480;
export const SNAPSHOT_HEIGHT = 360;

// Cap on retained keyframes. Past this, decimateSnapshots() halves the density
// of the oldest portion so the series stays bounded over a long session.
export const MAX_SNAPSHOTS = 80;

// Cadence: while the canvas is dirty, capture at most one timed snapshot every
// this-many ms. Meaningful events can capture sooner (still debounced).
export const SNAPSHOT_CADENCE_MS = 4000;
// Minimum gap between ANY two captures so a burst of events can't spam.
const MIN_CAPTURE_GAP_MS = 1200;

// IndexedDB key prefix for a per-artwork snapshot series in the "kv" store.
const REPLAY_KEY_PREFIX = "replay:v1:";

// The single stable key used for the studio's current/default session. The
// studio is single-artwork at a time, so one key is enough; the prefix keeps
// the shape ready for keying per-artwork/per-session later.
export const DEFAULT_REPLAY_ID = "current";

export function replayKey(id = DEFAULT_REPLAY_ID) {
  return `${REPLAY_KEY_PREFIX}${id}`;
}

// Persisted snapshot record. `blob` is the PNG; the rest mirrors
// `replay_snapshots` (seq, kind, width, height, capturedAt, changeScore). When
// synced, `blob` becomes a storage_ref/image_url upload.
function makeSnapshotRecord({ seq, blob, kind, capturedAt, changeScore }) {
  return {
    seq,
    blob,
    kind, // 'keyframe' | 'event' | 'manual'
    width: SNAPSHOT_WIDTH,
    height: SNAPSHOT_HEIGHT,
    capturedAt: capturedAt || new Date().toISOString(),
    changeScore: typeof changeScore === "number" ? changeScore : null,
  };
}

// Temporal decimation. Once the series exceeds `max`, drop every other snapshot
// in the OLDEST half so the early part of the session is sparser while recent
// activity stays dense. We always keep the very first and very last snapshots.
// Returns a NEW array (does not mutate the input).
export function decimateSnapshots(snapshots, max = MAX_SNAPSHOTS) {
  if (snapshots.length <= max) {
    return snapshots;
  }
  const result = snapshots.slice();
  // Repeat until back under the cap. Each pass thins the oldest portion.
  while (result.length > max) {
    const half = Math.floor(result.length / 2);
    const head = [];
    // Keep every other item in [1, half), always keeping index 0.
    head.push(result[0]);
    for (let i = 1; i < half; i += 1) {
      if (i % 2 === 0) {
        head.push(result[i]);
      }
    }
    const tail = result.slice(half); // recent portion kept dense
    const next = head.concat(tail);
    // Safety: if a pass didn't shrink the array (tiny arrays), force-trim head.
    if (next.length >= result.length) {
      result.splice(1, 1); // drop the second-oldest as a fallback
    } else {
      result.length = 0;
      result.push(...next);
    }
  }
  return result;
}

// A lightweight live recorder. The studio creates one per session. It does NOT
// own a canvas — the caller hands it a function that paints the current
// composite into a provided 2D context at SNAPSHOT_WIDTH x SNAPSHOT_HEIGHT.
//
// Usage:
//   const recorder = createReplayRecorder({ paintComposite });
//   recorder.markDirty();                 // on stroke-end / edits
//   recorder.captureEvent('layer_add');   // on meaningful events
//   const all = recorder.getSnapshots();  // for the player
//   await recorder.flush();               // persist to IndexedDB
export function createReplayRecorder({ paintComposite, id = DEFAULT_REPLAY_ID } = {}) {
  let snapshots = [];
  let seq = 0;
  let lastCaptureAt = 0;
  let dirty = false;
  let timer = 0;
  let onChange = null;
  let destroyed = false;

  // A reusable offscreen canvas for rendering each snapshot.
  let scratch = null;
  function getScratch() {
    if (!scratch) {
      scratch = document.createElement("canvas");
      scratch.width = SNAPSHOT_WIDTH;
      scratch.height = SNAPSHOT_HEIGHT;
    }
    return scratch;
  }

  function notify() {
    if (onChange) {
      onChange(snapshots.length);
    }
  }

  // Render + encode one snapshot to a PNG Blob, append it, decimate, and notify.
  async function capture(kind) {
    if (destroyed || typeof paintComposite !== "function") {
      return;
    }
    const now = Date.now();
    if (now - lastCaptureAt < MIN_CAPTURE_GAP_MS && kind !== "manual") {
      return;
    }
    const canvas = getScratch();
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
    try {
      paintComposite(context, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
    } catch {
      return; // a paint failure shouldn't break the draw loop
    }
    const blob = await new Promise((resolve) => {
      canvas.toBlob((value) => resolve(value), "image/png", 0.85);
    });
    if (!blob || destroyed) {
      return;
    }
    seq += 1;
    lastCaptureAt = now;
    dirty = false;
    snapshots.push(makeSnapshotRecord({ seq, blob, kind }));
    snapshots = decimateSnapshots(snapshots, MAX_SNAPSHOTS);
    notify();
  }

  // Schedule a timed keyframe if the canvas is dirty. Coalesces so idle time
  // never spams snapshots: the timer only fires a capture when `dirty` is set.
  function scheduleTimed() {
    if (timer || destroyed) {
      return;
    }
    timer = window.setTimeout(() => {
      timer = 0;
      if (dirty) {
        capture("keyframe");
      }
    }, SNAPSHOT_CADENCE_MS);
  }

  return {
    id,
    // Call after a stroke-batch / edit. Marks dirty and arms the timed cadence.
    markDirty() {
      dirty = true;
      scheduleTimed();
    },
    // Capture immediately on a meaningful event (debounced by MIN_CAPTURE_GAP).
    captureEvent() {
      // Treat the event itself as the change; capture an 'event' snapshot.
      dirty = true;
      capture("event");
    },
    // Force a snapshot now (e.g. user pressed "snapshot" / before export).
    captureManual() {
      return capture("manual");
    },
    getSnapshots() {
      return snapshots;
    },
    getCount() {
      return snapshots.length;
    },
    setOnChange(handler) {
      onChange = handler;
    },
    // Replace the in-memory series (used when loading a persisted session).
    setSnapshots(next) {
      snapshots = Array.isArray(next) ? next.slice() : [];
      seq = snapshots.reduce((max, snap) => Math.max(max, snap.seq || 0), 0);
      notify();
    },
    reset() {
      snapshots = [];
      seq = 0;
      lastCaptureAt = 0;
      dirty = false;
      notify();
    },
    // Persist the current series to IndexedDB (Blobs survive structured-clone).
    async flush() {
      if (!isIdbAvailable()) {
        return false;
      }
      try {
        await idbSetKV(replayKey(id), {
          version: 1,
          updatedAt: new Date().toISOString(),
          snapshots: snapshots.map((snap) => ({ ...snap })),
        });
        return true;
      } catch {
        return false;
      }
    },
    destroy() {
      destroyed = true;
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      onChange = null;
      scratch = null;
    },
  };
}

// Load a persisted snapshot series for an artwork. Returns the snapshot array
// (each with a `blob`) or [] when none/unavailable. Never throws.
export async function loadReplaySnapshots(id = DEFAULT_REPLAY_ID) {
  if (!isIdbAvailable()) {
    return [];
  }
  try {
    const record = await idbGetKV(replayKey(id));
    if (record && Array.isArray(record.snapshots)) {
      return record.snapshots;
    }
  } catch {
    // fall through to empty
  }
  return [];
}

export async function clearReplaySnapshots(id = DEFAULT_REPLAY_ID) {
  if (!isIdbAvailable()) {
    return;
  }
  try {
    await idbDeleteKV(replayKey(id));
  } catch {
    // non-fatal
  }
}
