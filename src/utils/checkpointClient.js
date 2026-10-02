// Trusted-checkpoint CLIENT: decode, validate and install the optional
// `history.checkpoint` baseline the server pairs with tail ops. The checkpoint
// is acceleration data only, the retained operation history stays
// authoritative, and ANY validation failure must fall back to a full replay
// (the App sends checkpoint_nack; see the history handler).
//
// Hard rules baked in here (see CHECKPOINT-CONTRACT.md):
//  - EVERY asset is decoded, dimension-checked and hashed (PNG bytes + RGBA)
//    and the mix state is validated BEFORE a single layer pixel is replaced;
//  - layer assets are full-document-resolution (4000x2500) transparent PNGs
//    installed per layer, visibility/opacity are composite-time concerns and
//    are never baked into the editable pixels, so hidden layers keep theirs;
//  - the layer-0 mix-map continuation state restores EXACTLY (data + dirty +
//    prefetched ledger), rebuilding it from pixels would change wet tails,
//    because the dirty-region cache intentionally retains stale sampled cells;
//  - decoding runs off the paint hot path: layers decode sequentially with
//    awaited, cancellable steps and bounded byte budgets, one shared scratch
//    canvas, and ImageBitmaps are closed the moment they land on a layer.
//
// The API is renderer-agnostic so phase 4 cold-frame hydrate / raster / export
// can reuse it: decodeCheckpoint() never touches the app's live layer stack -
// installCheckpointLayers() applies a decoded frame to any layer list whose
// metadata it was validated against.

import {
  CHECKPOINT_SCHEMA_VERSION,
  CHECKPOINT_WIDTH,
  CHECKPOINT_HEIGHT,
  CHECKPOINT_MAX_LAYER_BYTES,
  CHECKPOINT_MAX_FRAME_BYTES,
  CHECKPOINT_MAX_LAYERS,
  checkpointLayersKey,
  clientCheckpointVersion,
} from "./checkpointFormat";
import { MIX_SCALE } from "./mixMap";

// Expected mirror dimensions of the layer-0 mix map (see utils/mixMap.js).
const MIX_WIDTH = Math.ceil(CHECKPOINT_WIDTH / MIX_SCALE);
const MIX_HEIGHT = Math.ceil(CHECKPOINT_HEIGHT / MIX_SCALE);

// Whole-envelope decode budget across ALL frames (per-frame budgets are
// enforced separately). A multi-frame animation checkpoint is a subset of a
// scene, not a license to decode unbounded base64 on the join path.
const CHECKPOINT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;
// Strict Base64: alphabet only, length a multiple of 4, padding only at the end.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class CheckpointError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "CheckpointError";
    this.reason = reason;
  }
}

const fail = (reason, message) => {
  throw new CheckpointError(reason, message);
};

// What THIS bundle can verify. A stale bundle (no compile-time renderer
// fingerprint), no WebCrypto (can't hash), no createImageBitmap (can't decode
// off-thread) or no canvas 2d means the client must not advertise the cp
// capability at all, the server then sends the ordinary full history.
export function checkpointClientSupport() {
  const version = clientCheckpointVersion();
  if (!HEX64.test(version)) return "";
  try {
    if (typeof atob !== "function" || typeof btoa !== "function") return "";
    if (typeof Blob !== "function" || typeof createImageBitmap !== "function") return "";
    if (typeof ImageBitmap === "undefined") return "";
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== "function") return "";
    if (typeof document === "undefined") return "";
    const canvas = document.createElement("canvas");
    if (!canvas.getContext("2d")) return "";
  } catch {
    return "";
  }
  return version;
}

// Strict base64 → bytes with a PRE-decode size bound. Anything that is not a
// raw base64 body (data-URL prefixes, whitespace, bad alphabet/padding) is a
// 'base64' rejection; exceeding maxBytes is a 'bounds' rejection.
export function base64ToBytes(value, maxBytes, reason = "base64") {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    fail(reason, "malformed base64 payload");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const expected = (value.length / 4) * 3 - padding;
  if (expected > maxBytes) fail("bounds", "payload exceeds byte budget");
  let binary;
  try {
    binary = atob(value);
  } catch {
    fail(reason, "malformed base64 payload");
  }
  if (binary.length !== expected) fail(reason, "base64 length mismatch");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Chunked (String.fromCharCode has an argument-count ceiling).
export function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

// One shared decode scratch: 4000x2500 reused across layers/frames so a decode
// never stacks a full-res canvas per layer on top of the retained bitmaps.
let scratchCanvas = null;
const getScratch = () => {
  if (!scratchCanvas || scratchCanvas.width !== CHECKPOINT_WIDTH || scratchCanvas.height !== CHECKPOINT_HEIGHT) {
    scratchCanvas = document.createElement("canvas");
    scratchCanvas.width = CHECKPOINT_WIDTH;
    scratchCanvas.height = CHECKPOINT_HEIGHT;
  }
  return scratchCanvas;
};

const closeLayers = (layers) => {
  for (const layer of layers || []) {
    if (layer.bitmap) {
      try { layer.bitmap.close(); } catch { /* already closed */ }
      layer.bitmap = null;
    }
  }
};

// Free every decoded bitmap without installing (a superseded/canceled decode
// whose pixels must never reach the layer stack).
export function releaseCheckpoint(decoded) {
  for (const frame of decoded?.frames || []) closeLayers(frame.layers);
}

const validateRect = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail("mixstate", "mix bounds must be an object");
  const { x0, y0, w, h } = value;
  if (![x0, y0, w, h].every(Number.isFinite) || w < 0 || h < 0) fail("mixstate", "mix bounds must be finite, non-negative");
  return { x0, y0, w, h };
};

// Wire mix state {version,width,height,pixelsBase64,dirty,prefetched} → the
// Uint8ClampedArray shape createMixMap().restoreState() consumes (which then
// re-validates dimensions/length/bounds before mutating, double-gated). A
// non-wire `data` array/view is also accepted (cold-frame hydrate sources)
// after an exact length + per-value 0..255 integer check.
const decodeMixState = (state) => {
  if (!state || typeof state !== "object" || Array.isArray(state)) fail("mixstate", "missing mix state");
  if (state.version !== 1 || state.width !== MIX_WIDTH || state.height !== MIX_HEIGHT) {
    fail("mixstate", "mix state version/dimensions mismatch");
  }
  let data;
  if (typeof state.pixelsBase64 === "string") {
    const pixels = base64ToBytes(state.pixelsBase64, MIX_WIDTH * MIX_HEIGHT * 4, "mixstate");
    if (pixels.length !== MIX_WIDTH * MIX_HEIGHT * 4) fail("mixstate", "mix pixels length mismatch");
    data = new Uint8ClampedArray(pixels.length);
    data.set(pixels);
  } else if (Array.isArray(state.data) || ArrayBuffer.isView(state.data)) {
    const source = state.data;
    if (source.length !== MIX_WIDTH * MIX_HEIGHT * 4) fail("mixstate", "mix pixels length mismatch");
    data = new Uint8ClampedArray(source.length);
    for (let i = 0; i < source.length; i += 1) {
      const v = source[i];
      if (!Number.isInteger(v) || v < 0 || v > 255) fail("mixstate", "mix pixels must be bytes");
      data[i] = v;
    }
  } else {
    fail("mixstate", "mix state carries no pixels");
  }
  // Rects validate BEFORE anything here is handed to a live map.
  const dirty = validateRect(state.dirty);
  const prefetched = validateRect(state.prefetched);
  return { version: 1, width: MIX_WIDTH, height: MIX_HEIGHT, data, dirty, prefetched };
};

const decodeFrame = async (descriptor, context) => {
  const { expectedFrames, tailOps, limits, cancelled } = context;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) fail("frame", "frame descriptor must be an object");
  if (typeof descriptor.frameId !== "string" || !descriptor.frameId) fail("frame", "frame id missing");
  if (!Number.isSafeInteger(descriptor.throughOpId) || descriptor.throughOpId < 0) fail("watermark", "throughOpId must be a non-negative safe integer");
  const authoritative = expectedFrames.find((frame) => frame && frame.id === descriptor.frameId);
  if (!authoritative || !Array.isArray(authoritative.layers) || !authoritative.layers.length) {
    fail("frame", "frame missing from authoritative history metadata");
  }
  if (typeof descriptor.layersKey !== "string" || descriptor.layersKey !== checkpointLayersKey(authoritative.layers)) {
    fail("layersKey", "layersKey does not match authoritative layer metadata");
  }
  const layers = descriptor.layers;
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > limits.maxLayers || layers.length !== authoritative.layers.length) {
    fail("layers", "layer list shape mismatch");
  }
  layers.forEach((layer, index) => {
    if (!layer || typeof layer !== "object" || layer.id !== authoritative.layers[index].id) {
      fail("layers", "layer ids must match the authoritative order exactly");
    }
    if (!HEX64.test(layer.pngSha256 || "") || !HEX64.test(layer.rgbaSha256 || "")) fail("hash", "hash must be lowercase sha256 hex");
  });
  // The paired tail must sit strictly above the watermark, a re-delivered
  // prefix op would double-apply ink over the baseline. `tailLocalOps` (the
  // retained-ops path: cold-frame hydrate/raster re-decode) tolerates ops
  // with NO server opId: locally-originated strokes are appended to the
  // frame's op list before the server ids them, and they are by construction
  // newer than the join-time watermark. The wire path stays strict.
  if (Array.isArray(tailOps)) {
    for (const op of tailOps) {
      if (!op || (op.frameId !== undefined && op.frameId !== descriptor.frameId)) continue;
      if (!Number.isSafeInteger(op.opId)) {
        if (context.tailLocalOps) continue;
        fail("tail", "tail op missing its server opId");
      }
      if (op.opId <= descriptor.throughOpId) {
        fail("tail", "tail op at or below the checkpoint watermark");
      }
    }
  }

  cancelled();
  const decodedLayers = [];
  let frameBytes = 0;
  const scratch = getScratch();
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  try {
    for (const layer of layers) {
      const pngBytes = base64ToBytes(layer.pngBase64, limits.maxLayerBytes);
      frameBytes += pngBytes.length;
      if (frameBytes > limits.maxFrameBytes) fail("bounds", "frame exceeds byte budget");
      if (context.totalBytes + frameBytes > limits.maxTotalBytes) fail("bounds", "checkpoint exceeds total byte budget");
      if ((await sha256Hex(pngBytes)) !== layer.pngSha256) fail("hash", "pngSha256 mismatch");
      cancelled();
      let bitmap;
      try {
        bitmap = await createImageBitmap(new Blob([pngBytes], { type: "image/png" }));
      } catch {
        fail("png", "PNG did not decode");
      }
      if (bitmap.width !== CHECKPOINT_WIDTH || bitmap.height !== CHECKPOINT_HEIGHT) {
        bitmap.close();
        fail("dimensions", `layer PNG must be ${CHECKPOINT_WIDTH}x${CHECKPOINT_HEIGHT}`);
      }
      cancelled();
      // RGBA proof: draw at 1:1 and hash the exact pixels an install would land.
      scratchCtx.clearRect(0, 0, CHECKPOINT_WIDTH, CHECKPOINT_HEIGHT);
      scratchCtx.drawImage(bitmap, 0, 0);
      const rgba = scratchCtx.getImageData(0, 0, CHECKPOINT_WIDTH, CHECKPOINT_HEIGHT).data;
      if ((await sha256Hex(rgba)) !== layer.rgbaSha256) {
        bitmap.close();
        fail("hash", "rgbaSha256 mismatch");
      }
      decodedLayers.push({ id: layer.id, bitmap });
      cancelled();
    }
  } catch (error) {
    closeLayers(decodedLayers);
    throw error;
  }
  const mixState = decodeMixState(descriptor.mixState);
  return { frameId: descriptor.frameId, throughOpId: descriptor.throughOpId, layersKey: descriptor.layersKey, layers: decodedLayers, mixState, bytes: frameBytes };
};

// Decode + fully validate a checkpoint envelope against the authoritative
// history frame metadata. Resolves { frames: [decodedFrame] } where each
// decodedFrame is { frameId, throughOpId, layersKey, layers: [{id, bitmap}],
// mixState }. NOTHING here mutates a live canvas, install is a separate,
// explicit step. Rejects with CheckpointError { reason } and releases every
// partially decoded asset on any failure; 'canceled' means the caller's
// isCancelled() fired (a newer baseline superseded this one) and is NOT a
// corruption signal. (Pre-rename builds emitted the legacy 'cancelled'
// spelling, readers accept both via src/utils/cancellation.js.)
export async function decodeCheckpoint(checkpoint, options = {}) {
  const rendererVersion = options.rendererVersion ?? checkpointClientSupport();
  if (!rendererVersion || !HEX64.test(rendererVersion)) fail("unsupported", "client cannot verify checkpoints");
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) fail("schema", "checkpoint must be an object");
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) fail("schema", "unsupported schemaVersion");
  if (checkpoint.rendererVersion !== rendererVersion) fail("renderer", "renderer fingerprint mismatch");
  if (!Array.isArray(checkpoint.frames) || checkpoint.frames.length < 1) fail("frames", "checkpoint carries no frames");
  const expectedFrames = options.expectedFrames;
  if (!Array.isArray(expectedFrames) || expectedFrames.length < 1) fail("frame", "authoritative frame metadata required");
  const limits = {
    maxLayerBytes: options.limits?.maxLayerBytes ?? CHECKPOINT_MAX_LAYER_BYTES,
    maxFrameBytes: options.limits?.maxFrameBytes ?? CHECKPOINT_MAX_FRAME_BYTES,
    maxLayers: options.limits?.maxLayers ?? CHECKPOINT_MAX_LAYERS,
    maxTotalBytes: options.limits?.maxTotalBytes ?? CHECKPOINT_MAX_TOTAL_BYTES,
  };
  const cancelled = () => {
    if (options.isCancelled?.()) fail("canceled", "checkpoint superseded by a newer baseline");
  };
  cancelled();
  const frames = [];
  let totalBytes = 0;
  try {
    for (const descriptor of checkpoint.frames) {
      const frame = await decodeFrame(descriptor, { expectedFrames, tailOps: options.tailOps, limits, cancelled, totalBytes, tailLocalOps: !!options.tailLocalOps });
      totalBytes += frame.bytes;
      frames.push(frame);
    }
  } catch (error) {
    for (const frame of frames) closeLayers(frame.layers);
    throw error;
  }
  return { frames };
}

// Install a decoded frame onto its live layer stack: validate the id order one
// last time, then replace each layer's pixels with the verified full-res PNG
// (clear + 1:1 draw: NO visibility/opacity bake, so hidden layers keep their
// pixels and composite-time styling keeps working). Bitmaps are closed as they
// land. Returns the number of layers installed.
export function installCheckpointLayers(decodedFrame, liveLayers) {
  if (!decodedFrame || !Array.isArray(liveLayers) || liveLayers.length !== decodedFrame.layers.length) {
    fail("layers", "live layer stack does not match the decoded frame");
  }
  decodedFrame.layers.forEach((decoded, index) => {
    const live = liveLayers[index];
    if (!live || live.id !== decoded.id || !live.canvas) fail("layers", "live layer stack does not match the decoded frame");
  });
  for (let index = 0; index < decodedFrame.layers.length; index += 1) {
    const decoded = decodedFrame.layers[index];
    const canvas = liveLayers[index].canvas;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (decoded.bitmap) {
      ctx.drawImage(decoded.bitmap, 0, 0);
      try { decoded.bitmap.close(); } catch { /* already closed */ }
      decoded.bitmap = null;
    }
  }
  return decodedFrame.layers.length;
}

// The mix-map state a FRESH replay starts from (createMixMap's birth: zeroed
// pixels, fully dirty, no prefetch ledger). A wholesale history replay rebuilds
// layer 0 from nothing, so the shared map must restart from the same birth
// state: NOT keep the previous session's sampled ledger (stale cells from
// before the clear would survive in regions the replay never marks) and NOT be
// blanket re-read at the end either (that would destroy the deliberately-stale
// sampled cells the op-order replay just rebuilt, diverging future wet dabs
// from every peer). Restoring this at replay start makes a full-history join's
// post-replay ledger byte-identical to a checkpoint join's restored + tail
// ledger: both are "birth + the same ops in the same order".
export function freshMixState() {
  return {
    version: 1,
    width: MIX_WIDTH,
    height: MIX_HEIGHT,
    data: new Uint8ClampedArray(MIX_WIDTH * MIX_HEIGHT * 4),
    dirty: { x0: 0, y0: 0, w: CHECKPOINT_WIDTH, h: CHECKPOINT_HEIGHT },
    prefetched: null,
  };
}

// Post-nack / unsupported-client guard. When a checkpoint is present but NOT
// being used (this connection already nacked, or the bundle can't verify),
// the paired op list is only safe to replay as a full baseline when it still
// carries every checkpointed frame's WHOLE history. For each descriptor with
// a non-zero watermark the ops must include at least one op at or below that
// watermark, otherwise that frame's ink is a bare tail, and replaying it
// over a cleared canvas paints truncated art. Returns the first uncovered
// frameId, or null when the baseline is complete (safe to ignore the
// checkpoint and replay the ops).
export function checkpointTailOnlyFrame(checkpoint, ops, fallbackFrameId = null) {
  const frames = Array.isArray(checkpoint?.frames) ? checkpoint.frames : [];
  const list = Array.isArray(ops) ? ops : [];
  for (const descriptor of frames) {
    if (!descriptor || typeof descriptor.frameId !== "string") continue;
    if (!Number.isSafeInteger(descriptor.throughOpId) || descriptor.throughOpId <= 0) continue;
    const covered = list.some((op) => {
      if (!op || !Number.isSafeInteger(op.opId) || op.opId > descriptor.throughOpId) return false;
      const opFrame = op.frameId !== undefined ? op.frameId : fallbackFrameId;
      return opFrame === descriptor.frameId;
    });
    if (!covered) return descriptor.frameId;
  }
  return null;
}
