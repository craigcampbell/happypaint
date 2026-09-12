// Rotoscoping: trace over a video, frame by frame. The clip stays LOCAL to
// this browser (an object URL on a hidden <video>) — it is never uploaded,
// never shown to friends and never exported; only the drawings are. Each cel
// shows the clip at that cel's moment in the film (its start time plus a
// user-set offset), seeked on demand and drawn under the layers at the
// chosen opacity.

import { CANVAS_WIDTH, CANVAS_HEIGHT } from "./layers";

export const VIDEO_TRACE_MAX_BYTES = 200 * 1024 * 1024;

export function createVideoTrace(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    const fail = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This video can't be played here — try an MP4 or WebM clip"));
    };
    video.onerror = fail;
    video.onloadedmetadata = () => {
      if (!video.duration || !video.videoWidth) {
        fail();
        return;
      }
      // Aspect-fit the clip into the mural (same framing as a trace photo).
      const scale = Math.min(CANVAS_WIDTH / video.videoWidth, CANVAS_HEIGHT / video.videoHeight);
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      const rect = { x: (CANVAS_WIDTH - w) / 2, y: (CANVAS_HEIGHT - h) / 2, w, h };
      resolve({
        name: file.name,
        url,
        video,
        durationMs: Math.round(video.duration * 1000),
        width: video.videoWidth,
        height: video.videoHeight,
        rect,
        opacity: 0.55,
        offsetMs: 0, // where in the clip the film's first frame sits
        visible: true,
        seekGen: 0,
        currentMs: -1,
      });
    };
    video.src = url;
  });
}

export function disposeVideoTrace(trace) {
  if (!trace) return;
  try {
    trace.video.pause();
    trace.video.removeAttribute("src");
    trace.video.load();
  } catch {
    /* ignore */
  }
  URL.revokeObjectURL(trace.url);
}

// Seek the clip to `ms` (clamped to the clip) and resolve once the frame is
// decoded. Rapid calls coalesce: only the latest resolves true.
export function seekVideoTrace(trace, ms) {
  const gen = (trace.seekGen += 1);
  const clamped = Math.max(0, Math.min(trace.durationMs - 1, ms));
  if (Math.abs(trace.currentMs - clamped) < 1) return Promise.resolve(true);
  return new Promise((resolve) => {
    const video = trace.video;
    const done = () => {
      video.removeEventListener("seeked", done);
      if (gen !== trace.seekGen) {
        resolve(false);
        return;
      }
      trace.currentMs = clamped;
      resolve(true);
    };
    video.addEventListener("seeked", done);
    try {
      video.currentTime = clamped / 1000;
    } catch {
      video.removeEventListener("seeked", done);
      resolve(false);
    }
  });
}

// Draw the clip's current frame into a document-sized context.
export function drawVideoTrace(ctx, trace, width = CANVAS_WIDTH, height = CANVAS_HEIGHT) {
  if (!trace || !trace.visible || trace.currentMs < 0) return;
  const sx = width / CANVAS_WIDTH;
  const sy = height / CANVAS_HEIGHT;
  ctx.save();
  ctx.globalAlpha = trace.opacity;
  ctx.drawImage(trace.video, trace.rect.x * sx, trace.rect.y * sy, trace.rect.w * sx, trace.rect.h * sy);
  ctx.restore();
}

// How many frames of `holdMs` it takes to cover the clip from `offsetMs`.
export function framesToCoverClip(trace, holdMs) {
  const remaining = Math.max(0, trace.durationMs - trace.offsetMs);
  return Math.ceil(remaining / Math.max(40, holdMs));
}
