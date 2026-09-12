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
//
// Minutes-long films (stage 3): the muxer streams its output into Blob parts
// instead of one growing ArrayBuffer (fragmented MP4 / streaming WebM past
// LONG_FILM_MS), the bitrate scales down so a long film stays under a sane
// file size, an optional soundtrack is encoded (Opus, or AAC in MP4 where the
// platform can) and muxed alongside the video, and `signal` cancels.

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
const MIN_BITRATE = 1_200_000;
const TARGET_MAX_BYTES = 220 * 1024 * 1024; // a long film's file-size ceiling (phones share it)
const LONG_FILM_MS = 90_000; // past this the muxer streams instead of buffering one ArrayBuffer
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_BITRATE = 128_000;

function totalDurationMs(job) {
  let total = 0;
  for (let i = 0; i < job.count; i += 1) total += Math.max(40, job.durationMsAt(i));
  return total;
}

// A long film at 6Mbps would be gigabytes; scale the bitrate so the file
// lands under TARGET_MAX_BYTES (never below a watchable floor).
export function bitrateFor(durationMs) {
  const seconds = Math.max(1, durationMs / 1000);
  return Math.round(Math.max(MIN_BITRATE, Math.min(BITRATE, (TARGET_MAX_BYTES * 8) / seconds)));
}

async function supportedConfig(codec, width, height, bitrate) {
  try {
    const support = await window.VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate,
      framerate: 30,
    });
    return support && support.supported ? support.config : null;
  } catch {
    return null;
  }
}

async function supportedAudioConfig(codec, numberOfChannels) {
  if (typeof window.AudioEncoder !== "function") return null;
  try {
    const support = await window.AudioEncoder.isConfigSupported({
      codec,
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels,
      bitrate: AUDIO_BITRATE,
    });
    return support && support.supported ? support.config : null;
  } catch {
    return null;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
}

// Encode the soundtrack (planar Float32 channels at AUDIO_SAMPLE_RATE) and hand
// every chunk to the muxer. Runs BEFORE the video loop: the muxer interleaves
// by timestamp, and audio is cheap next to rasterising frames.
async function encodeAudioTrack(muxer, audio, audioConfig, signal) {
  const { channelData, numberOfChannels } = audio;
  const frames = channelData[0].length;
  let encodeError = null;
  const encoder = new window.AudioEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addAudioChunk(chunk, meta);
      } catch (error) {
        encodeError = error;
      }
    },
    error: (err) => {
      encodeError = err;
    },
  });
  try {
    encoder.configure(audioConfig);
    const CHUNK = AUDIO_SAMPLE_RATE; // one second per AudioData
    for (let offset = 0; offset < frames; offset += CHUNK) {
      throwIfAborted(signal);
      if (encodeError) throw encodeError;
      const length = Math.min(CHUNK, frames - offset);
      const planar = new Float32Array(length * numberOfChannels);
      for (let c = 0; c < numberOfChannels; c += 1) {
        planar.set(channelData[c].subarray(offset, offset + length), c * length);
      }
      const data = new window.AudioData({
        format: "f32-planar",
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfFrames: length,
        numberOfChannels,
        timestamp: Math.round((offset / AUDIO_SAMPLE_RATE) * 1_000_000),
        data: planar,
      });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
      while (encoder.encodeQueueSize > 8) {
        if (encodeError) throw encodeError;
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
}

async function encodeWithWebCodecs(job, attempt, config) {
  const { width, height, count, durationMsAt, draw, onProgress, signal, audio } = job;
  const { Muxer, ArrayBufferTarget, StreamTarget } = await loadMuxer(attempt.container);
  const durationMs = totalDurationMs(job);
  const longFilm = durationMs > LONG_FILM_MS;

  // Audio track config (Opus everywhere; AAC in MP4 when the platform encodes it).
  let audioConfig = null;
  let muxAudio = null;
  if (audio && audio.channelData?.[0]?.length && typeof window.AudioEncoder === "function") {
    const channels = audio.numberOfChannels;
    if (attempt.container === "mp4") {
      audioConfig = await supportedAudioConfig("mp4a.40.2", channels);
      if (audioConfig) muxAudio = { codec: "aac", sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: channels };
    }
    if (!audioConfig) {
      audioConfig = await supportedAudioConfig("opus", channels);
      if (audioConfig) {
        muxAudio = attempt.container === "mp4"
          ? { codec: "opus", sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: channels }
          : { codec: "A_OPUS", sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: channels };
      }
    }
  }

  // Output sink: one ArrayBuffer for short films (non-fragmented MP4 with the
  // moov up front plays everywhere); Blob parts streamed from the muxer for
  // long ones (fragmented MP4 / streaming WebM write monotonically).
  const parts = [];
  const target = longFilm
    ? new StreamTarget({ onData: (data) => parts.push(data.slice()), chunked: true })
    : new ArrayBufferTarget();
  const muxer =
    attempt.container === "mp4"
      ? new Muxer({
          target,
          video: { codec: "avc", width, height },
          audio: muxAudio || undefined,
          fastStart: longFilm ? "fragmented" : "in-memory",
          firstTimestampBehavior: "offset",
        })
      : new Muxer({
          target,
          video: { codec: attempt.webmCodecId, width, height },
          audio: muxAudio || undefined,
          streaming: longFilm,
          firstTimestampBehavior: "offset",
        });

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
    if (muxAudio) await encodeAudioTrack(muxer, audio, audioConfig, signal);
    encoder.configure(config);
    let timestampUs = 0;
    for (let i = 0; i < count; i += 1) {
      throwIfAborted(signal);
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
    const blob = longFilm ? new Blob(parts, { type: mime }) : new Blob([target.buffer], { type: mime });
    return { blob, ext: attempt.container === "mp4" ? "mp4" : "webm", audio: !!muxAudio };
  } finally {
    // Every failed codec attempt releases its hardware resources before retry.
    if (encoder.state !== "closed") encoder.close();
    canvas.width = 1;
    canvas.height = 1;
    parts.length = 0;
  }
}

// Last resort: play the animation onto a captured canvas in real time. Total
// wall time = the animation's length (loops are seconds long — acceptable).
// No soundtrack on this rung.
async function recordWithMediaRecorder({ width, height, count, durationMsAt, draw, onProgress, signal }) {
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
      throwIfAborted(signal);
      if (recordError) throw recordError;
      if (i > 0) await draw(context, i);
      onProgress?.((i + 1) / count);
      await new Promise((resolve) => setTimeout(resolve, Math.max(40, durationMsAt(i))));
    }
    if (recorder.state !== "inactive") recorder.stop();
    await stopped;
    if (recordError) throw recordError;
    const ext = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    return { blob: new Blob(chunks, { type: mimeType }), ext, audio: false };
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

// job: { width, height, count, durationMsAt(i)->ms, draw: async (ctx, i), onProgress?,
//        allowMediaRecorder?, signal?: AbortSignal,
//        audio?: { sampleRate: 48000, numberOfChannels, channelData: Float32Array[] } }
// Callers which page remote scenes must disable real-time recording: waiting
// for scene hydration would otherwise silently lengthen the exported film.
export async function encodeAnimationVideo(job) {
  // Encoders want even dimensions.
  const width = Math.max(2, Math.floor(job.width / 2) * 2);
  const height = Math.max(2, Math.floor(job.height / 2) * 2);
  const sized = { ...job, width, height };

  if (typeof window.VideoEncoder === "function" && typeof window.VideoFrame === "function") {
    const bitrate = bitrateFor(totalDurationMs(sized));
    const attempts = [
      { container: "mp4", codec: "avc1.42001f" }, // H.264 baseline
      { container: "webm", codec: "vp09.00.10.08", webmCodecId: "V_VP9" },
      { container: "webm", codec: "vp8", webmCodecId: "V_VP8" },
    ];
    for (const attempt of attempts) {
      throwIfAborted(job.signal);
      const config = await supportedConfig(attempt.codec, width, height, bitrate);
      if (!config) continue;
      try {
        return await encodeWithWebCodecs(sized, attempt, config);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        // Codec claimed support but failed mid-encode — try the next rung.
      }
    }
  }
  if (job.allowMediaRecorder === false) {
    throw new Error("This film needs a working WebCodecs encoder. Export one scene at a time on this browser.");
  }
  return recordWithMediaRecorder(sized);
}
