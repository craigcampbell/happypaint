// NSFW watcher — Web Worker (ALL inference happens here, never on the main thread).
//
// PERF GUARANTEE
//   The main thread hands us a small ImageBitmap (<= maxDim px on its longest side,
//   default 256) by transfer and gets back a single number (0..1). We do every pixel
//   read here, on a worker, against an OffscreenCanvas — so the drawing hot path in
//   App.jsx never sees a getImageData call, a pixel loop, or a model. The bitmap is
//   closed after each scan to keep memory flat.
//
// DETECTOR
//   The shipped detector is NSFWJS (MobileNetV2), lazy-loaded via dynamic import
//   the FIRST time an elected watcher scans — NEVER at startup and NEVER for
//   non-watchers, so page load, the bundle, and the drawing path stay untouched
//   for everyone else. The model weights are bundled with nsfwjs (no network
//   fetch, no third-party call — fits the self-hosted / offline / kid-privacy
//   posture). If the model can't load (old browser, backend init failure) we fall
//   back to the dependency-free `heuristicDetect`, so a failed load can never
//   stall moderation or touch the canvas.

let canvas = null;
let ctx = null;

// Lazy detector promise — created on first scan, reused thereafter.
let detectorPromise = null;

// Load NSFWJS once, on the first real scan. Returns an async (imageData)=>score.
function loadDetector() {
  if (!detectorPromise) {
    detectorPromise = buildNsfwDetector().catch(() => heuristicDetect);
  }
  return detectorPromise;
}

async function buildNsfwDetector() {
  // Dynamic imports → Vite code-splits TF.js + NSFWJS into their own chunks that
  // only download for an elected watcher, the first time it scans.
  const [{ load }, { MobileNetV2Model }, tf] = await Promise.all([
    import("nsfwjs/core"),
    import("nsfwjs/models/mobilenet_v2"),
    import("@tensorflow/tfjs"),
  ]);

  // Pick a worker-safe backend: prefer WebGL (fast, via OffscreenCanvas), fall
  // back to the pure-JS CPU backend, which always works in a Worker.
  try {
    await tf.setBackend("webgl");
    await tf.ready();
  } catch {
    await tf.setBackend("cpu");
    await tf.ready();
  }

  // Bundled MobileNetV2 — no fetch. load() runs a warmup predict; if the chosen
  // backend is broken this throws and we retry on CPU before giving up.
  let model;
  try {
    model = await load("MobileNetV2", { modelDefinitions: [MobileNetV2Model], size: 224 });
  } catch (err) {
    if (tf.getBackend() !== "cpu") {
      await tf.setBackend("cpu");
      await tf.ready();
      model = await load("MobileNetV2", { modelDefinitions: [MobileNetV2Model], size: 224 });
    } else {
      throw err;
    }
  }

  return async (imageData) => {
    // Build the input tensor by hand (RGB, transparent->white "paper") so we never
    // touch tf.browser.fromPixels — that path can need a DOM canvas and is flaky
    // in Workers. This works identically on the CPU and WebGL backends.
    const input = imageDataToTensor(tf, imageData);
    try {
      const preds = await model.classify(input); // resizes to 224 internally
      return scoreFromPredictions(preds);
    } finally {
      input.dispose();
    }
  };
}

// Collapse NSFWJS's five classes into one 0..1 "lewd" score for a kids' drawing
// app: Porn/Hentai (explicit photos & drawings) count fully, Sexy (suggestive but
// not explicit) at half weight; Drawing (safe sketches/anime) and Neutral are safe.
function scoreFromPredictions(preds) {
  let score = 0;
  for (const p of preds || []) {
    if (p.className === "Porn" || p.className === "Hentai") score += p.probability;
    else if (p.className === "Sexy") score += 0.5 * p.probability;
  }
  return clamp01(score);
}

// RGBA ImageData -> an int32 [h,w,3] tensor. Transparent pixels become white so
// the classifier sees art on paper rather than on black.
function imageDataToTensor(tf, imageData) {
  const { data, width, height } = imageData;
  const px = width * height;
  const rgb = new Uint8Array(px * 3);
  for (let p = 0, s = 0, d = 0; p < px; p += 1, s += 4, d += 3) {
    if (data[s + 3] < 32) {
      rgb[d] = 255;
      rgb[d + 1] = 255;
      rgb[d + 2] = 255;
    } else {
      rgb[d] = data[s];
      rgb[d + 1] = data[s + 1];
      rgb[d + 2] = data[s + 2];
    }
  }
  return tf.tensor3d(rgb, [height, width, 3], "int32");
}

/**
 * Dependency-free heuristic: how much of the image is skin-toned, and how large is
 * the single biggest contiguous skin region. A large connected flesh area scores
 * higher than skin scattered as noise (a face, a hand, or a beach photo), which
 * keeps innocent art from tripping. Returns 0..1; tuning lives entirely here.
 */
function heuristicDetect(imageData) {
  const { data, width, height } = imageData;
  const total = width * height;
  if (total === 0) {
    return 0;
  }

  // Per-pixel skin mask (packed 0/1), reused for connected-component labeling.
  const mask = new Uint8Array(total);
  let skinCount = 0;

  for (let p = 0, i = 0; p < total; p += 1, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 32) {
      continue; // transparent canvas region — ignore
    }
    if (isSkin(r, g, b)) {
      mask[p] = 1;
      skinCount += 1;
    }
  }

  const skinRatio = skinCount / total;
  if (skinCount === 0) {
    return 0;
  }

  // Largest contiguous skin region via iterative (stack-based) flood fill.
  let largest = 0;
  const stack = new Int32Array(total);
  for (let start = 0; start < total; start += 1) {
    if (mask[start] !== 1) {
      continue;
    }
    let size = 0;
    let sp = 0;
    stack[sp += 1] = start;
    mask[start] = 2; // mark visited
    while (sp > 0) {
      const cur = stack[sp -= 1];
      size += 1;
      const x = cur % width;
      const y = (cur - x) / width;
      // 4-neighbourhood
      if (x > 0 && mask[cur - 1] === 1) {
        mask[cur - 1] = 2;
        stack[sp += 1] = cur - 1;
      }
      if (x < width - 1 && mask[cur + 1] === 1) {
        mask[cur + 1] = 2;
        stack[sp += 1] = cur + 1;
      }
      if (y > 0 && mask[cur - width] === 1) {
        mask[cur - width] = 2;
        stack[sp += 1] = cur - width;
      }
      if (y < height - 1 && mask[cur + width] === 1) {
        mask[cur + width] = 2;
        stack[sp += 1] = cur + width;
      }
    }
    if (size > largest) {
      largest = size;
    }
  }

  const largestRatio = largest / total;

  // Combine: overall skin coverage gates, a big connected flesh blob amplifies.
  // Both are normalised against rough thresholds so the score saturates at 1.
  const coverageScore = clamp01(skinRatio / 0.45);
  const blobScore = clamp01(largestRatio / 0.30);
  const score = clamp01(0.4 * coverageScore + 0.6 * blobScore);
  return score;
}

// Loose YCbCr + RGB skin-tone test. Best-effort and intentionally generous; the
// connected-region term above is what separates real flesh from incidental skin
// pixels, so a permissive per-pixel test is fine.
function isSkin(r, g, b) {
  // RGB rule (Kovac et al.) for well-lit skin.
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const rgbRule =
    r > 95 &&
    g > 40 &&
    b > 20 &&
    max - min > 15 &&
    Math.abs(r - g) > 15 &&
    r > g &&
    r > b;

  // YCbCr rule catches a broader range of tones / lighting.
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const ycbcrRule = cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;

  return rgbRule || ycbcrRule;
}

function clamp01(n) {
  if (n < 0) {
    return 0;
  }
  if (n > 1) {
    return 1;
  }
  return n;
}

async function scan(bitmap) {
  const width = bitmap.width;
  const height = bitmap.height;

  // Reuse a single OffscreenCanvas sized to the incoming bitmap.
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }

  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  const detect = await loadDetector();
  const score = await detect(imageData);
  return clamp01(Number(score) || 0);
}

self.onmessage = async (event) => {
  const { id, bitmap } = event.data || {};
  if (typeof id !== "number" || !bitmap) {
    return;
  }
  try {
    const score = await scan(bitmap);
    self.postMessage({ id, ok: true, score });
  } catch (error) {
    // A worker failure must never propagate to the canvas; report and move on.
    try {
      bitmap?.close?.();
    } catch {
      // ignore
    }
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
};
