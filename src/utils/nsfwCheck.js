// One-shot NSFW classification for a user-uploaded image, reusing the same
// worker + model the ambient room watcher uses (src/workers/nsfwWatcher.worker.js).
// This is a best-effort CLIENT pre-check before a trace photo is broadcast —
// the real safety control is the server-side host gate. If the model can't load
// (older/mobile device, blocked), it resolves `null` and the caller proceeds,
// trusting the gate + the report path.

let sharedWorker = null;
let jobSeq = 0;

function getWorker() {
  if (sharedWorker) return sharedWorker;
  try {
    sharedWorker = new Worker(new URL("../workers/nsfwWatcher.worker.js", import.meta.url), { type: "module" });
  } catch {
    sharedWorker = null;
  }
  return sharedWorker;
}

// Decode a data URL / blob URL to an ImageBitmap downscaled to <= maxDim on its
// longest side (keeps the transfer + inference cheap).
async function toBitmap(src, maxDim = 256) {
  const res = await fetch(src);
  const blob = await res.blob();
  const full = await createImageBitmap(blob);
  const scale = Math.min(1, maxDim / Math.max(full.width, full.height));
  if (scale >= 1) return full;
  const w = Math.max(1, Math.round(full.width * scale));
  const h = Math.max(1, Math.round(full.height * scale));
  const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" });
  full.close?.();
  return small;
}

// Returns a lewd-ness score in [0,1], or null if it couldn't run.
// Resolves within `timeoutMs` no matter what so an upload never hangs.
export function classifyImageNsfw(dataUrl, { timeoutMs = 9000 } = {}) {
  const worker = getWorker();
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = (jobSeq += 1);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      worker.removeEventListener("message", onMsg);
      window.clearTimeout(timer);
      resolve(v);
    };
    const onMsg = (event) => {
      const d = event.data || {};
      if (d.id !== id) return;
      finish(d.ok ? Math.max(0, Math.min(1, Number(d.score) || 0)) : null);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    worker.addEventListener("message", onMsg);
    toBitmap(dataUrl)
      .then((bitmap) => worker.postMessage({ id, bitmap }, [bitmap]))
      .catch(() => finish(null));
  });
}
