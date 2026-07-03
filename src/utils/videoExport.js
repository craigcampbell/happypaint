// Client-side animation video export. Everything runs in the browser — the
// server has no rendering stack (and never needs one: the brush engine only
// exists here).
//
// Codec ladder:
//   1. WebCodecs H.264  -> .mp4  (plays everywhere: iMessage, Discord, camera roll)
//   2. WebCodecs VP9/VP8 -> .webm (Chromium builds without the H.264 encoder)
//   3. MediaRecorder     -> .webm (older browsers; records in real time)
//
// Frames are drawn ON DEMAND through a caller-supplied draw() callback into one
// reusable canvas, so a 24-frame export never holds 24 full-res snapshots.
// Timestamps honor the authored per-frame durations exactly — no fixed-fps
// resampling, so a 500ms hold really holds.

import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";

const KEYFRAME_EVERY = 30; // encoded frames between forced keyframes
const BITRATE = 6_000_000;

async function supportedConfig(codec, width, height) {
  try {
    const support = await window.VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate: BITRATE,
      framerate: 30,
    });
    return support && support.supported ? support.config : null;
  } catch {
    return null;
  }
}

async function encodeWithWebCodecs({ width, height, count, durationMsAt, draw, onProgress }, attempt, config) {
  const target = attempt.container === "mp4" ? new Mp4Target() : new WebmTarget();
  const muxer =
    attempt.container === "mp4"
      ? new Mp4Muxer({
          target,
          video: { codec: "avc", width, height },
          fastStart: "in-memory", // whole file is small; moov up front = instant playback
        })
      : new WebmMuxer({ target, video: { codec: attempt.webmCodecId, width, height } });

  let encodeError = null;
  const encoder = new window.VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err;
    },
  });
  encoder.configure(config);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  let timestampUs = 0;
  for (let i = 0; i < count; i += 1) {
    if (encodeError) throw encodeError;
    await draw(context, i);
    const durationUs = Math.max(40, durationMsAt(i)) * 1000;
    const videoFrame = new window.VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs });
    encoder.encode(videoFrame, { keyFrame: i % KEYFRAME_EVERY === 0 });
    videoFrame.close();
    timestampUs += durationUs;
    onProgress?.((i + 1) / count);
    // Keep the encode queue shallow so memory stays flat on long exports.
    if (encoder.encodeQueueSize > 4) {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }
  await encoder.flush();
  encoder.close();
  if (encodeError) throw encodeError;
  muxer.finalize();
  const mime = attempt.container === "mp4" ? "video/mp4" : "video/webm";
  return { blob: new Blob([target.buffer], { type: mime }), ext: attempt.container === "mp4" ? "mp4" : "webm" };
}

// Last resort: play the animation onto a captured canvas in real time. Total
// wall time = the animation's length (loops are seconds long — acceptable).
async function recordWithMediaRecorder({ width, height, count, durationMsAt, draw, onProgress }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const stream = canvas.captureStream(30);
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
    (candidate) => window.MediaRecorder && window.MediaRecorder.isTypeSupported(candidate),
  );
  if (!mimeType) throw new Error("no video encoder available");
  const recorder = new window.MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITRATE });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });

  await draw(context, 0); // first frame on screen before recording starts
  recorder.start();
  try {
    for (let i = 0; i < count; i += 1) {
      await draw(context, i);
      onProgress?.((i + 1) / count);
      await new Promise((resolve) => setTimeout(resolve, Math.max(40, durationMsAt(i))));
    }
  } finally {
    recorder.stop(); // never leak a running recorder if draw throws
  }
  await stopped;
  const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  return { blob: new Blob(chunks, { type: mimeType }), ext };
}

// job: { width, height, count, durationMsAt(i)->ms, draw: async (ctx, i), onProgress? }
export async function encodeAnimationVideo(job) {
  // Encoders want even dimensions.
  const width = Math.max(2, Math.floor(job.width / 2) * 2);
  const height = Math.max(2, Math.floor(job.height / 2) * 2);
  const sized = { ...job, width, height };

  if (typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function") {
    const attempts = [
      { container: "mp4", codec: "avc1.42001f" }, // H.264 baseline
      { container: "webm", codec: "vp09.00.10.08", webmCodecId: "V_VP9" },
      { container: "webm", codec: "vp8", webmCodecId: "V_VP8" },
    ];
    for (const attempt of attempts) {
      const config = await supportedConfig(attempt.codec, width, height);
      if (!config) continue;
      try {
        return await encodeWithWebCodecs(sized, attempt, config);
      } catch {
        // Codec claimed support but failed mid-encode — try the next rung.
      }
    }
  }
  return recordWithMediaRecorder(sized);
}
