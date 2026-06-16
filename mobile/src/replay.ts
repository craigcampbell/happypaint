// Room Replay & Timelapse — SNAPSHOT-BASED process capture (not per-stroke).
// Mirrors src/utils/replay.js, adapted to RN (expo-file-system + AsyncStorage +
// Skia capture handed in by the studio).
//
// Design rationale (docs/product-research.md §"Room Replay and Timelapse"):
//   - We capture downscaled COMPOSITED PNG snapshots of the artwork over time,
//     NOT a stroke stream. Storage stays bounded, the result is correct
//     regardless of stroke complexity / how many painters touch the canvas, and
//     the existing GIF encoder (gif.ts) is reused for the timelapse export.
//   - Snapshots are taken on a cadence (every few seconds *while the canvas is
//     dirty*) AND on meaningful events (stroke/shape commit, layer add/delete,
//     frame change). Idle time never spams snapshots (the recorder is debounced
//     and only fires a timed snapshot when something actually changed).
//   - Temporal decimation: total keyframes are capped (~80). When the cap is
//     exceeded we drop every other snapshot in the OLDEST portion of the series,
//     halving its density so a long session stays bounded yet watchable.
//
// Coordination with the export lock: the studio passes a `capture` function that
// is already export-lock-aware (it acquires the same single in-flight lock the
// PNG/GIF/loop exports use). The recorder never captures while a capture is
// already in flight, and event/timed captures are dropped (not queued) if the
// canvas is busy, so snapshotting can NEVER deadlock or race a real export. A
// failed/skipped capture simply leaves the canvas dirty for the next tick.
//
// Storage: each snapshot PNG is a FILE (expo-file-system) under the replay dir;
// the per-artwork index lives in AsyncStorage. The record shape mirrors the
// backend `replay_snapshots` table (seq, capturedAt, kind, width, height) so it
// is sync-ready (the file uri becomes a storage_ref/image_url upload later).

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  deleteReplaySnapshotFile,
  ensureReplayDirReady,
  replaySnapshotPath,
  writePng
} from "./storage";
import type { ReplaySnapshot, ReplaySnapshotKind } from "./types";

// Downscaled snapshot size — small enough that ~80 PNGs is a few MB, and a good
// source resolution for the GIF timelapse (which can downscale further).
export const SNAPSHOT_WIDTH = 480;
export const SNAPSHOT_HEIGHT = 360;

// Cap on retained keyframes. Past this, decimateSnapshots() halves the density
// of the oldest portion so the series stays bounded over a long session.
export const MAX_SNAPSHOTS = 80;

// Cadence: while the canvas is dirty, capture at most one timed snapshot every
// this-many ms. Meaningful events can capture sooner (still gap-limited).
export const SNAPSHOT_CADENCE_MS = 4000;
// Minimum gap between ANY two captures so a burst of events can't spam.
const MIN_CAPTURE_GAP_MS = 1200;

const REPLAY_INDEX_PREFIX = "happy-paint:replay:index:v1:";

export function replayIndexKey(replayId: string) {
  return `${REPLAY_INDEX_PREFIX}${replayId}`;
}

// A base64 PNG plus its true pixel size, produced by the studio's capture path.
export type CapturedSnapshot = {
  base64: string;
  width: number;
  height: number;
};

// Temporal decimation. Once the series exceeds `max`, drop every other snapshot
// in the OLDEST half so the early part of the session is sparser while recent
// activity stays dense. We always keep the very first and very last snapshots.
// Returns a NEW array (does not mutate the input). The DROPPED records are
// returned too so the caller can delete their files.
export function decimateSnapshots(
  snapshots: ReplaySnapshot[],
  max = MAX_SNAPSHOTS
): { kept: ReplaySnapshot[]; dropped: ReplaySnapshot[] } {
  if (snapshots.length <= max) {
    return { kept: snapshots, dropped: [] };
  }
  const keptSeqs = new Set<number>();
  let result = snapshots.slice();
  while (result.length > max) {
    const half = Math.floor(result.length / 2);
    const head: ReplaySnapshot[] = [];
    head.push(result[0]); // always keep the oldest
    for (let i = 1; i < half; i += 1) {
      if (i % 2 === 0) {
        head.push(result[i]);
      }
    }
    const tail = result.slice(half); // recent portion kept dense
    const next = head.concat(tail);
    if (next.length >= result.length) {
      // Safety: a pass didn't shrink (tiny arrays). Force-trim the 2nd-oldest.
      result.splice(1, 1);
    } else {
      result = next;
    }
  }
  for (const snap of result) {
    keptSeqs.add(snap.seq);
  }
  const dropped = snapshots.filter((snap) => !keptSeqs.has(snap.seq));
  return { kept: result, dropped };
}

// Persisted index: just the snapshot records (file uris live inside each).
async function readIndex(replayId: string): Promise<ReplaySnapshot[]> {
  try {
    const raw = await AsyncStorage.getItem(replayIndexKey(replayId));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as ReplaySnapshot[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(replayId: string, snapshots: ReplaySnapshot[]) {
  await AsyncStorage.setItem(replayIndexKey(replayId), JSON.stringify(snapshots));
}

// Load a persisted snapshot series for an artwork. Never throws.
export async function loadReplaySnapshots(replayId: string): Promise<ReplaySnapshot[]> {
  const snapshots = await readIndex(replayId);
  return snapshots.sort((a, b) => a.seq - b.seq);
}

// Delete a whole artwork's snapshot series (index + files). Never throws.
export async function clearReplaySnapshots(replayId: string): Promise<void> {
  const snapshots = await readIndex(replayId);
  await AsyncStorage.removeItem(replayIndexKey(replayId));
  for (const snap of snapshots) {
    await deleteReplaySnapshotFile(snap.uri);
  }
}

// Account-deletion helper: remove EVERY artwork's replay index key from
// AsyncStorage (the prefix is shared, one key per artwork). The snapshot PNG
// files live under the replay dir, which storage.wipeStorageFiles() removes;
// this clears the lightweight indexes. Best-effort, never throws.
export async function clearAllReplayIndexes(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const replayKeys = keys.filter((key) => key.startsWith(REPLAY_INDEX_PREFIX));
    if (replayKeys.length > 0) {
      await AsyncStorage.multiRemove(replayKeys);
    }
  } catch {
    // non-fatal — a failed clear must not abort the wider deletion
  }
}

// A lightweight live recorder. The studio creates one per artwork. It does NOT
// own a canvas — the caller hands it an async `capture()` that returns a
// downscaled base64 PNG (export-lock-aware). The recorder writes each snapshot
// to a file, maintains the index, decimates, and persists.
//
// Usage in the studio:
//   const recorder = createReplayRecorder({ replayId, capture });
//   recorder.markDirty();                  // after a stroke/shape commit
//   recorder.captureEvent("layer_add");    // on meaningful events
//   await recorder.captureManual();        // user pressed "snapshot"
//   recorder.destroy();                    // on unmount / project switch
export type ReplayRecorder = {
  markDirty: () => void;
  captureEvent: () => void;
  captureManual: () => Promise<void>;
  getCount: () => number;
  setOnChange: (handler: ((count: number) => void) | null) => void;
  destroy: () => void;
};

export function createReplayRecorder(options: {
  replayId: string;
  // Returns a downscaled base64 PNG of the current composite, or null if a
  // capture can't run right now (e.g. an export already owns the canvas). MUST
  // coordinate with the studio's single in-flight export lock so snapshotting
  // never races a real export.
  capture: () => Promise<CapturedSnapshot | null>;
  initialSnapshots?: ReplaySnapshot[];
}): ReplayRecorder {
  const { replayId, capture } = options;
  let snapshots: ReplaySnapshot[] = (options.initialSnapshots ?? []).slice();
  let seq = snapshots.reduce((max, snap) => Math.max(max, snap.seq), 0);
  let lastCaptureAt = 0;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onChange: ((count: number) => void) | null = null;
  let destroyed = false;
  // Guard so two captures (e.g. a timed one and an event one) can't interleave
  // inside the recorder itself; the studio's export lock guards against the
  // wider export flows.
  let capturing = false;

  function notify() {
    onChange?.(snapshots.length);
  }

  async function persist() {
    try {
      await ensureReplayDirReady();
      await writeIndex(replayId, snapshots);
    } catch {
      // non-fatal — the series stays in memory and retries next persist
    }
  }

  async function runCapture(kind: ReplaySnapshotKind) {
    if (destroyed || capturing) {
      return;
    }
    const now = Date.now();
    if (kind !== "manual" && now - lastCaptureAt < MIN_CAPTURE_GAP_MS) {
      return;
    }
    capturing = true;
    try {
      const shot = await capture();
      if (!shot || destroyed) {
        // A skipped/failed capture leaves `dirty` set so the next tick retries.
        return;
      }
      seq += 1;
      const thisSeq = seq;
      const uri = replaySnapshotPath(replayId, thisSeq);
      await ensureReplayDirReady();
      await writePng(uri, shot.base64);
      lastCaptureAt = now;
      dirty = false;
      snapshots.push({
        seq: thisSeq,
        uri,
        kind,
        width: shot.width,
        height: shot.height,
        capturedAt: now
      });
      const { kept, dropped } = decimateSnapshots(snapshots, MAX_SNAPSHOTS);
      snapshots = kept;
      for (const gone of dropped) {
        await deleteReplaySnapshotFile(gone.uri);
      }
      await persist();
      notify();
    } catch {
      // swallow — a capture failure must never break the draw loop
    } finally {
      capturing = false;
    }
  }

  // Schedule a timed keyframe if the canvas is dirty. The timer only fires a
  // capture when `dirty` is set, so idle time never spams snapshots.
  function scheduleTimed() {
    if (timer || destroyed) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (dirty && !destroyed) {
        void runCapture("keyframe");
      }
    }, SNAPSHOT_CADENCE_MS);
  }

  return {
    markDirty() {
      dirty = true;
      scheduleTimed();
    },
    captureEvent() {
      dirty = true;
      void runCapture("event");
    },
    captureManual() {
      return runCapture("manual");
    },
    getCount() {
      return snapshots.length;
    },
    setOnChange(handler) {
      onChange = handler;
    },
    destroy() {
      destroyed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      onChange = null;
    }
  };
}
