// Photoshop .ABR import MVP.
//
// ABR has multiple generations and no complete public modern spec. This module
// intentionally extracts only safe brush-tip assets:
// - embedded PNG/JPEG/WebP rasters when present
// - legacy sampled grayscale tips with rect/depth/compression records
//
// It does not try to clone Photoshop's brush engine. The caller maps extracted
// tips into HappyPaint's v3 stamp recipes.

const TIP_SIZES = [192, 160, 128, 96];
const MAX_TIP_DATA_URL = 96_000;
const MAX_EXTRACTED_TIPS = 32;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG_SOI = [0xff, 0xd8];
const JPG_EOI = [0xff, 0xd9];

function beU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function beI16(bytes, offset) {
  const value = beU16(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function beU32(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])) >>> 0;
}

function startsWith(bytes, offset, signature) {
  if (offset + signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function dataUrlToImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function normalizeImageDataUrl(dataUrl) {
  const image = await dataUrlToImage(dataUrl);
  for (const size of TIP_SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, size, size);
    const scale = Math.min(size / image.width, size / image.height);
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const x = Math.round((size - w) / 2);
    const y = Math.round((size - h) / 2);
    context.drawImage(image, x, y, w, h);
    const out = canvas.toDataURL("image/png");
    if (out.length <= MAX_TIP_DATA_URL || size === TIP_SIZES[TIP_SIZES.length - 1]) {
      return out;
    }
  }
  return "";
}

async function bytesToTipDataUrl(bytes, type) {
  const blob = new Blob([bytes], { type });
  const dataUrl = await blobToDataUrl(blob);
  return normalizeImageDataUrl(dataUrl);
}

function findPngRanges(bytes) {
  const ranges = [];
  for (let start = 0; start < bytes.length - PNG_SIG.length; start += 1) {
    if (!startsWith(bytes, start, PNG_SIG)) continue;
    let offset = start + PNG_SIG.length;
    while (offset + 12 <= bytes.length) {
      const length = beU32(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      const next = offset + 12 + length;
      if (next > bytes.length) break;
      if (type === "IEND") {
        ranges.push({ start, end: next, type: "image/png" });
        start = next - 1;
        break;
      }
      offset = next;
    }
  }
  return ranges;
}

function findJpegRanges(bytes) {
  const ranges = [];
  for (let start = 0; start < bytes.length - 4; start += 1) {
    if (!startsWith(bytes, start, JPG_SOI)) continue;
    for (let end = start + 2; end < bytes.length - 1; end += 1) {
      if (startsWith(bytes, end, JPG_EOI)) {
        ranges.push({ start, end: end + 2, type: "image/jpeg" });
        start = end + 1;
        break;
      }
    }
  }
  return ranges;
}

function findWebpRanges(bytes) {
  const ranges = [];
  for (let start = 0; start < bytes.length - 12; start += 1) {
    if (ascii(bytes, start, 4) !== "RIFF" || ascii(bytes, start + 8, 4) !== "WEBP") continue;
    const length = bytes[start + 4] | (bytes[start + 5] << 8) | (bytes[start + 6] << 16) | (bytes[start + 7] << 24);
    const end = start + 8 + length;
    if (end <= bytes.length && end > start + 12) {
      ranges.push({ start, end, type: "image/webp" });
      start = end - 1;
    }
  }
  return ranges;
}

function rowBytesFor(width, depth) {
  if (depth === 1) return Math.ceil(width / 8);
  if (depth === 8) return width;
  if (depth === 16) return width * 2;
  return 0;
}

function decodePackBits(input, outLength) {
  const out = new Uint8Array(outLength);
  let src = 0;
  let dst = 0;
  while (src < input.length && dst < outLength) {
    const n = input[src++] << 24 >> 24;
    if (n >= 0) {
      const count = n + 1;
      out.set(input.subarray(src, Math.min(input.length, src + count)), dst);
      src += count;
      dst += count;
    } else if (n >= -127) {
      const count = 1 - n;
      const value = input[src++] || 0;
      out.fill(value, dst, Math.min(outLength, dst + count));
      dst += count;
    }
  }
  return out;
}

function alphaFromMask(mask, width, height, depth) {
  const rowBytes = rowBytesFor(width, depth);
  const alpha = new Uint8ClampedArray(width * height);
  if (depth === 1) {
    for (let y = 0; y < height; y += 1) {
      const row = y * rowBytes;
      for (let x = 0; x < width; x += 1) {
        alpha[y * width + x] = mask[row + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
      }
    }
  } else if (depth === 8) {
    for (let y = 0; y < height; y += 1) {
      alpha.set(mask.subarray(y * rowBytes, y * rowBytes + width), y * width);
    }
  } else if (depth === 16) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        alpha[y * width + x] = mask[y * rowBytes + x * 2];
      }
    }
  }
  return alpha;
}

function usefulAlpha(alpha) {
  let painted = 0;
  let sum = 0;
  for (let i = 0; i < alpha.length; i += 1) {
    if (alpha[i] > 8) painted += 1;
    sum += alpha[i];
  }
  const coverage = painted / Math.max(1, alpha.length);
  const avg = sum / Math.max(1, alpha.length);
  return coverage > 0.01 && coverage < 0.98 && avg > 2;
}

function alphaToTipDataUrl(alpha, width, height) {
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const context = source.getContext("2d");
  const image = context.createImageData(width, height);
  for (let i = 0; i < alpha.length; i += 1) {
    const j = i * 4;
    image.data[j] = 0;
    image.data[j + 1] = 0;
    image.data[j + 2] = 0;
    image.data[j + 3] = alpha[i];
  }
  context.putImageData(image, 0, 0);

  for (const size of TIP_SIZES) {
    const out = document.createElement("canvas");
    out.width = size;
    out.height = size;
    const outCtx = out.getContext("2d");
    const scale = Math.min(size / width, size / height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const x = Math.round((size - w) / 2);
    const y = Math.round((size - h) / 2);
    outCtx.clearRect(0, 0, size, size);
    outCtx.drawImage(source, x, y, w, h);
    const dataUrl = out.toDataURL("image/png");
    if (dataUrl.length <= MAX_TIP_DATA_URL || size === TIP_SIZES[TIP_SIZES.length - 1]) {
      return dataUrl;
    }
  }
  return "";
}

function tryReadLegacySample(bytes, offset) {
  if (offset + 11 >= bytes.length) return null;
  const top = beI16(bytes, offset);
  const left = beI16(bytes, offset + 2);
  const bottom = beI16(bytes, offset + 4);
  const right = beI16(bytes, offset + 6);
  const width = right - left;
  const height = bottom - top;
  const depth = beU16(bytes, offset + 8);
  const compression = bytes[offset + 10];
  if (width <= 0 || height <= 0 || width > 2048 || height > 2048) return null;
  if (![1, 8, 16].includes(depth) || ![0, 1].includes(compression)) return null;

  const rowBytes = rowBytesFor(width, depth);
  const rawLength = rowBytes * height;
  let pos = offset + 11;
  let mask = null;

  if (compression === 0) {
    if (pos + rawLength > bytes.length) return null;
    mask = bytes.subarray(pos, pos + rawLength);
    pos += rawLength;
  } else {
    if (pos + height * 2 > bytes.length) return null;
    const lengths = [];
    let compressedLength = 0;
    for (let y = 0; y < height; y += 1) {
      const len = beU16(bytes, pos + y * 2);
      if (len <= 0 || len > rowBytes * 3 + 64) return null;
      lengths.push(len);
      compressedLength += len;
    }
    pos += height * 2;
    if (pos + compressedLength > bytes.length) return null;
    const decoded = new Uint8Array(rawLength);
    let src = pos;
    for (let y = 0; y < height; y += 1) {
      const row = decodePackBits(bytes.subarray(src, src + lengths[y]), rowBytes);
      decoded.set(row, y * rowBytes);
      src += lengths[y];
    }
    pos += compressedLength;
    mask = decoded;
  }

  const alpha = alphaFromMask(mask, width, height, depth);
  if (!usefulAlpha(alpha)) return null;
  return { alpha, width, height, next: pos };
}

function findLegacySampledTips(bytes, limit) {
  const tips = [];
  const seen = new Set();
  const version = bytes.length >= 4 ? beU16(bytes, 0) : 0;
  const count = bytes.length >= 4 ? beU16(bytes, 2) : 0;

  let offset = 4;
  if ((version === 1 || version === 2) && count > 0 && count <= limit * 8) {
    for (let i = 0; i < count && tips.length < limit; i += 1) {
      const sample = tryReadLegacySample(bytes, offset);
      if (!sample) break;
      const key = `${sample.width}x${sample.height}:${sample.alpha[0]}:${sample.alpha[sample.alpha.length - 1]}:${offset}`;
      if (!seen.has(key)) {
        seen.add(key);
        tips.push(sample);
      }
      offset = sample.next;
    }
  }

  for (let pos = 0; pos < bytes.length - 32 && tips.length < limit; pos += 1) {
    const sample = tryReadLegacySample(bytes, pos);
    if (!sample) continue;
    const key = `${sample.width}x${sample.height}:${sample.alpha[0]}:${sample.alpha[sample.alpha.length - 1]}:${pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tips.push(sample);
    pos = sample.next - 1;
  }
  return tips;
}

function dedupeByDataUrl(tips) {
  const seen = new Set();
  return tips.filter((tip) => {
    const key = tip.tipDataUrl.slice(0, 80) + tip.tipDataUrl.length;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function extractAbrBrushTips(arrayBuffer, { maxTips = MAX_EXTRACTED_TIPS } = {}) {
  const bytes = new Uint8Array(arrayBuffer);
  const tips = [];
  const ranges = [
    ...findPngRanges(bytes),
    ...findJpegRanges(bytes),
    ...findWebpRanges(bytes),
  ].sort((a, b) => a.start - b.start);

  for (const range of ranges) {
    if (tips.length >= maxTips) break;
    try {
      const tipDataUrl = await bytesToTipDataUrl(bytes.subarray(range.start, range.end), range.type);
      if (tipDataUrl && tipDataUrl.length <= MAX_TIP_DATA_URL) {
        tips.push({
          title: `ABR Tip ${tips.length + 1}`,
          tipDataUrl,
          source: range.type.replace("image/", ""),
        });
      }
    } catch {
      // Skip unreadable embedded raster blocks.
    }
  }

  const legacy = findLegacySampledTips(bytes, Math.max(0, maxTips - tips.length));
  for (const sample of legacy) {
    if (tips.length >= maxTips) break;
    const tipDataUrl = alphaToTipDataUrl(sample.alpha, sample.width, sample.height);
    if (tipDataUrl && tipDataUrl.length <= MAX_TIP_DATA_URL) {
      tips.push({
        title: `ABR Tip ${tips.length + 1}`,
        tipDataUrl,
        source: `sampled ${sample.width}x${sample.height}`,
      });
    }
  }

  return dedupeByDataUrl(tips).slice(0, maxTips);
}
