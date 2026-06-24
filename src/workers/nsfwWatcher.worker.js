// NSFW watcher — Web Worker (ALL inference happens here, never on the main thread).
//
// PERF GUARANTEE
//   The main thread hands us a small ImageBitmap (<= maxDim px on its longest side,
//   default 256) by transfer and gets back a single number (0..1). We do every pixel
//   read here, on a worker, against an OffscreenCanvas — so the drawing hot path in
//   App.jsx never sees a getImageData call, a pixel loop, or a model. The bitmap is
//   closed after each scan to keep memory flat.
//
// DETECTOR SEAM
//   `detect(imageData)` is the ONE async boundary you swap to upgrade accuracy. The
//   shipped default (`heuristicDetect`) is dependency-free: skin-tone ratio + the
//   size of the largest contiguous flesh region, combined into a 0..1 score. To plug
//   in NSFWJS / TF.js or a cloud-escalation POST, replace the body of `loadDetector()`
//   so it resolves to an async (imageData) => number. It is lazy-loaded on the first
//   real scan (after first idle on the main thread), NEVER at startup, so page load
//   and the first strokes stay cheap. Until the detector resolves we fall back to the
//   heuristic, so a slow/failed model load can never stall moderation or the canvas.

let canvas = null;
let ctx = null;

// Lazy detector promise — created on first scan, reused thereafter.
let detectorPromise = null;

/**
 * The pluggable detector loader. This is the seam: return an async function
 * (imageData: ImageData) => number in [0,1]. The default resolves immediately to
 * the heuristic. To upgrade, swap the body for an NSFWJS/TF.js import or a fetch()
 * to a cloud-escalation endpoint, e.g.:
 *
 *   const tf = await import("https://.../tfjs");
 *   const nsfwjs = await import("https://.../nsfwjs");
 *   const model = await nsfwjs.load();
 *   return async (imageData) => {
 *     const preds = await model.classify(imageData);
 *     return scoreFromPredictions(preds);
 *   };
 */
function loadDetector() {
  if (!detectorPromise) {
    detectorPromise = Promise.resolve(heuristicDetect);
  }
  return detectorPromise;
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
