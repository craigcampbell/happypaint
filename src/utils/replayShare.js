// Replay/timelapse SHARING artifacts (studio owner).
//
// Why this exists: the old share path handed the OS share sheet an animated
// GIF whose FIRST frame is near-blank paper (a process timelapse starts at
// the first strokes). Instagram/Android share targets can't ingest animated
// GIFs and flatten to frame 0 — the receiver sees a white picture even though
// the artwork is fully present in later frames.
//
// The contract here:
//   - buildReplayShareAsset() -> MP4 (H.264, plays everywhere) when the
//     browser's WebCodecs encoder supports it, otherwise an explicit
//     finished-frame PNG (the LAST snapshot = the artwork as it ended).
//     It NEVER returns a GIF. The GIF timelapse stays available as a
//     separate, explicit "Save GIF" download.
//   - An optional Inktober-themed border + prompt caption is drawn onto the
//     EXPORT pixels only. Source snapshots and the stored/live art are never
//     touched (the border would otherwise be baked into the room's mural).
//   - shareFile() preserves user-activation semantics: after async prep the
//     browser may have lost the gesture, in which case it reports
//     "needs-gesture" so the UI can offer a separate "tap to share" button
//     that calls it again from a fresh tap.
//   - Everything honors an AbortSignal (encode cancellation).

import { encodeAnimationVideo } from "./videoExport.js";

export const REPLAY_SHARE_WIDTH = 480;
export const REPLAY_SHARE_HEIGHT = 360;

// Per-frame pacing, mirroring the GIF timelapse: ~10fps with a lingering
// final frame so the finished art is what a viewer (or a first/last-frame
// extractor) actually sees.
const FRAME_MS = 110;
const LAST_FRAME_MS = 900;

// Inktober export border palette (export pixels only — never the stored art).
const BORDER_INK = "#241d2e";
const BORDER_PAPER = "#fdfbf7";

function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new DOMException("Share preparation cancelled", "AbortError");
  }
}

// Does this browser's WebCodecs stack encode H.264 at the share size?
export async function supportsMp4Share(width = REPLAY_SHARE_WIDTH, height = REPLAY_SHARE_HEIGHT) {
  if (typeof window === "undefined") return false;
  if (typeof window.VideoEncoder !== "function" || typeof window.VideoFrame !== "function") return false;
  try {
    const support = await window.VideoEncoder.isConfigSupported({
      codec: "avc1.42001f", // H.264 baseline — the plays-everywhere rung
      width: even(width),
      height: even(height),
      bitrate: 1_500_000,
      framerate: 30,
    });
    return Boolean(support && support.supported);
  } catch {
    return false;
  }
}

function decodeSnapshot(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = (error) => {
      URL.revokeObjectURL(url);
      reject(error);
    };
    image.src = url;
  });
}

// Paint ONE export frame: white paper + the snapshot, or the Inktober-themed
// treatment (ink border + caption band with the prompt). Export pixels only —
// the caller's canvas is the only thing touched.
export function paintExportFrame(
  context,
  image,
  { width = REPLAY_SHARE_WIDTH, height = REPLAY_SHARE_HEIGHT, themed = false, prompt = null, eventLabel = null } = {},
) {
  if (!themed) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    if (image) context.drawImage(image, 0, 0, width, height);
    return;
  }
  const s = width / REPLAY_SHARE_WIDTH; // border metrics scale with the export size
  const edge = 8 * s;
  const caption = 26 * s;
  // Ink field (the border), paper inset, then the art inside that.
  context.fillStyle = BORDER_INK;
  context.fillRect(0, 0, width, height);
  context.fillStyle = BORDER_PAPER;
  context.fillRect(edge, edge, width - edge * 2, height - edge * 2);
  if (image) {
    const artX = edge + 6 * s;
    const artY = edge + 6 * s;
    const artW = width - artX * 2;
    const artH = height - artY - edge - caption - 4 * s;
    context.drawImage(image, artX, artY, artW, artH);
  }
  // Caption band: event label + the day's prompt, in ink on the paper band.
  const label = eventLabel || "Inktober";
  const text = prompt ? `${label} — “${prompt}”` : label;
  context.fillStyle = BORDER_INK;
  context.font = `${Math.max(10, 12 * s)}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, width / 2, height - edge - caption / 2, width - edge * 4);
}

// Explicit finished-frame PNG: the LAST snapshot (the artwork as it ended),
// optionally with the themed border. Returns a Blob (image/png) or null.
export async function buildFinishedPng({
  snapshots,
  width = REPLAY_SHARE_WIDTH,
  height = REPLAY_SHARE_HEIGHT,
  themed = false,
  prompt = null,
  eventLabel = null,
  signal,
} = {}) {
  throwIfAborted(signal);
  const list = (snapshots || []).filter((snap) => snap && snap.blob);
  if (list.length === 0) return null;
  const image = await decodeSnapshot(list[list.length - 1].blob);
  throwIfAborted(signal);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paintExportFrame(canvas.getContext("2d"), image, { width, height, themed, prompt, eventLabel });
  return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Build the shareable artifact from the recorder's snapshot series.
//   -> { kind: "mp4", blob, ext: "mp4", mime: "video/mp4" } when H.264 encodes
//   -> { kind: "png", blob, ext: "png", mime: "image/png" } explicit fallback
//   -> null when there is nothing to share
// Never a GIF. Throws AbortError when `signal` cancels.
export async function buildReplayShareAsset({
  snapshots,
  width = REPLAY_SHARE_WIDTH,
  height = REPLAY_SHARE_HEIGHT,
  signal,
  themed = false,
  prompt = null,
  eventLabel = null,
  onProgress,
} = {}) {
  throwIfAborted(signal);
  const list = (snapshots || []).filter((snap) => snap && snap.blob);
  if (list.length === 0) return null;

  if (await supportsMp4Share(width, height)) {
    try {
      const images = [];
      for (const snap of list) {
        throwIfAborted(signal);
        images.push(await decodeSnapshot(snap.blob));
      }
      throwIfAborted(signal);
      const result = await encodeAnimationVideo({
        width,
        height,
        count: images.length,
        durationMsAt: (index) => (index === images.length - 1 ? LAST_FRAME_MS : FRAME_MS),
        draw: async (context, index) => {
          paintExportFrame(context, images[index], { width, height, themed, prompt, eventLabel });
        },
        onProgress,
        signal,
        // No MediaRecorder rung here: a real-time webm re-record is not a
        // shareable-on-Instagram artifact either; the PNG fallback is explicit.
        allowMediaRecorder: false,
      });
      if (result && result.ext === "mp4" && result.blob) {
        return { kind: "mp4", blob: result.blob, ext: "mp4", mime: "video/mp4" };
      }
      // A non-mp4 rung won (e.g. only VP9 encoded) — fall through to PNG.
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // The encoder claimed support but failed mid-run: explicit PNG fallback.
    }
  }

  const png = await buildFinishedPng({ snapshots: list, width, height, themed, prompt, eventLabel, signal });
  if (!png) return null;
  return { kind: "png", blob: png, ext: "png", mime: "image/png" };
}

// Hand a prepared file to the OS share sheet, preserving user-activation
// semantics. Returns:
//   "shared"        — the sheet completed
//   "aborted"       — the user dismissed the sheet (not a failure)
//   "unsupported"   — no Web Share file support here (caller downloads instead)
//   "needs-gesture" — the async prep consumed the user activation; the caller
//                     must re-call this from a fresh tap ("tap to share")
//   "failed"        — anything else
export async function shareFile(file, shareData) {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
    return "unsupported";
  }
  try {
    if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) {
      return "unsupported";
    }
  } catch {
    return "unsupported";
  }
  try {
    await navigator.share(shareData);
    return "shared";
  } catch (error) {
    if (error?.name === "AbortError") return "aborted";
    if (error?.name === "NotAllowedError" || error?.name === "InvalidStateError" || error?.name === "SecurityError") {
      return "needs-gesture";
    }
    return "failed";
  }
}
