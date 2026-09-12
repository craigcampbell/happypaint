// Film soundtrack: one audio file per room (host-gated server upload, see
// server.js set_soundtrack), decoded once into an AudioBuffer. The studio plays
// it in sync with scene playback, and the exporters render the exact slice a
// film (or one scene) covers into planar 48kHz samples for the muxer.

export const SOUNDTRACK_MAX_BYTES = 8 * 1024 * 1024;
export const SOUNDTRACK_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/webm", "audio/flac"];
const EXPORT_RATE = 48_000;

let sharedContext = null;
export function audioContext() {
  if (!sharedContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    sharedContext = new Ctx();
  }
  return sharedContext;
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// Decode any browser-supported audio into an AudioBuffer (throws on junk).
export async function decodeSoundtrack(arrayBuffer) {
  const ctx = audioContext();
  if (!ctx) throw new Error("no audio support");
  return ctx.decodeAudioData(arrayBuffer.slice(0));
}

// Play `buffer` from `offsetMs` (a scene's start within the film). Returns a
// stop() — call it when playback stops or restarts. `onEnded` fires if the
// track runs out before the scene does.
export function playSoundtrack(buffer, offsetMs, onEnded) {
  const ctx = audioContext();
  if (!ctx || !buffer) return () => {};
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const offset = Math.max(0, offsetMs / 1000);
  if (offset >= buffer.duration) return () => {};
  source.onended = () => onEnded?.();
  source.start(0, offset);
  return () => {
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* already stopped */
    }
    source.disconnect();
  };
}

// Render the slice of the soundtrack a film covers — from `offsetMs` for
// `durationMs` — into planar 48kHz channel data (silence-padded when the track
// is shorter). This is what the video encoder muxes.
export async function renderSoundtrackSlice(buffer, offsetMs, durationMs) {
  if (!buffer || durationMs <= 0) return null;
  const numberOfChannels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const frames = Math.ceil((durationMs / 1000) * EXPORT_RATE);
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Offline) return null;
  const offline = new Offline(numberOfChannels, frames, EXPORT_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  const offset = Math.max(0, offsetMs / 1000);
  if (offset < buffer.duration) source.start(0, offset);
  const rendered = await offline.startRendering();
  const channelData = [];
  for (let c = 0; c < numberOfChannels; c += 1) channelData.push(rendered.getChannelData(c));
  return { sampleRate: EXPORT_RATE, numberOfChannels, channelData };
}
