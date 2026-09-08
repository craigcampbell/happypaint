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

// mp4-muxer / webm-muxer are only needed when actually exporting a video, so
// they're lazy-loaded on first use (they'd otherwise sit in the startup bundle
// for every visitor, including marketing-only page loads).
const muxerPromises = new Map();
function loadMuxer(container) {
  if (!muxerPromises.has(container)) {
    const pending = container === "mp4" ? import("mp4-muxer") : import("webm-muxer");
    muxerPromises.set(container, pending.catch((error) => {
      // A transient chunk-download failure must not poison future exports.
      muxerPromises.delete(container);
      throw error;
    }));
  }
  return muxerPromises.get(container);
}

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
  const { Muxer, ArrayBufferTarget } = await loadMuxer(attempt.container);
  const target = new ArrayBufferTarget();
  const muxer =
    attempt.container === "mp4"
      ? new Muxer({
          target,
          video: { codec: "avc", width, height },
          fastStart: "in-memory", // whole file is small; moov up front = instant playback
        })
      : new Muxer({ target, video: { codec: attempt.webmCodecId, width, height } });

  let encodeError = null;
  const encoder = new window.VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (error) {
        encodeError = error;
      }
    },
    error: (err) => {
      encodeError = err;
    },
  });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  try {
    encoder.configure(config);
    let timestampUs = 0;
    for (let i = 0; i < count; i += 1) {
      if (encodeError) throw encodeError;
      await draw(context, i);
      const durationUs = Math.max(40, durationMsAt(i)) * 1000;
      const videoFrame = new window.VideoFrame(canvas, { timestamp: timestampUs, duration: durationUs });
      try {
        encoder.encode(videoFrame, { keyFrame: i % KEYFRAME_EVERY === 0 });
      } finally {
        videoFrame.close();
      }
      timestampUs += durationUs;
      onProgress?.((i + 1) / count);
      // Wait until the queue drains, including on slow software encoders.
      while (encoder.encodeQueueSize > 4) {
        if (encodeError) throw encodeError;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    const mime = attempt.container === "mp4" ? "video/mp4" : "video/webm";
    return { blob: new Blob([target.buffer], { type: mime }), ext: attempt.container === "mp4" ? "mp4" : "webm" };
  } finally {
    // Every failed codec attempt releases its hardware resources before retry.
    if (encoder.state !== "closed") encoder.close();
    canvas.width = 1;
    canvas.height = 1;
  }
}

// Last resort: play the animation onto a captured canvas in real time. Total
// wall time = the animation's length (loops are seconds long — acceptable).
async function recordWithMediaRecorder({ width, height, count, durationMsAt, draw, onProgress }) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"].find(
    (candidate) => window.MediaRecorder && window.MediaRecorder.isTypeSupported(candidate),
  );
  if (!mimeType || typeof canvas.captureStream !== "function") throw new Error("no video encoder available");
  const stream = canvas.captureStream(30);
  let recorder;
  try {
    recorder = new window.MediaRecorder(stream, { mimeType, videoBitsPerSecond: BITRATE });
    const chunks = [];
    let recordError = null;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.onerror = (event) => {
        recordError = event.error || new Error("video recording failed");
        resolve();
      };
    });

    await draw(context, 0); // first frame on screen before recording starts
    recorder.start();
    for (let i = 0; i < count; i += 1) {
      if (recordError) throw recordError;
      if (i > 0) await draw(context, i);
      onProgress?.((i + 1) / count);
      await new Promise((resolve) => setTimeout(resolve, Math.max(40, durationMsAt(i))));
    }
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    if (recordError) throw recordError;
    const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    return { blob: new Blob(chunks, { type: mimeType }), ext };
  } finally {
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

// job: { width, height, count, durationMsAt(i)->ms, draw: async (ctx, i), onProgress?, allowMediaRecorder? }
// Callers which page remote scenes must disable real-time recording: waiting
// for scene hydration would otherwise silently lengthen the exported film.
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
  if (job.allowMediaRecorder === false) {
    throw new Error("This film needs a working WebCodecs encoder. Export one scene at a time on this browser.");
  }
  return recordWithMediaRecorder(sized);
}
