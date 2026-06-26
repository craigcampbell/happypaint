// Self-contained animated GIF89a encoder. No npm dependency.
//
// Approach:
//  - Build a single global 256-color palette across all frames using a
//    median-cut quantizer over a sampled set of pixels (fully opaque pixels
//    are quantized; near-transparent pixels map to a reserved transparent
//    color index so loops drawn on a clear background stay clean).
//  - For each frame, map every pixel to its nearest palette index (with a
//    small cache) and LZW-compress the index stream (GIF variable-width LZW).
//  - Emit: header `GIF89a`, logical screen descriptor + global color table,
//    a NETSCAPE2.0 application extension (loop forever), then per frame a
//    graphic control extension (delay + transparent index) and an image
//    descriptor with the compressed data, finally the trailer `0x3B`.
//
// Output is a Uint8Array of valid GIF bytes.

const TRANSPARENT_ALPHA_THRESHOLD = 16;

// ---- Byte buffer ----------------------------------------------------------

class ByteBuffer {
  constructor(initialCapacity = 1024) {
    // Growable typed buffer (W8): avoids building a huge boxed number[] and a
    // final Uint8Array.from copy. Capacity doubles as needed; `length` tracks
    // the bytes actually written.
    this.buffer = new Uint8Array(Math.max(16, initialCapacity));
    this.length = 0;
  }

  ensureCapacity(extra) {
    const needed = this.length + extra;
    if (needed <= this.buffer.length) {
      return;
    }
    let capacity = this.buffer.length;
    while (capacity < needed) {
      capacity *= 2;
    }
    const next = new Uint8Array(capacity);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
  }

  writeByte(value) {
    this.ensureCapacity(1);
    this.buffer[this.length] = value & 0xff;
    this.length += 1;
  }

  writeBytes(values) {
    this.ensureCapacity(values.length);
    for (let i = 0; i < values.length; i += 1) {
      this.buffer[this.length] = values[i] & 0xff;
      this.length += 1;
    }
  }

  // Little-endian 16-bit (GIF uses LE for screen size, delays, loop count).
  writeShort(value) {
    this.ensureCapacity(2);
    this.buffer[this.length] = value & 0xff;
    this.buffer[this.length + 1] = (value >> 8) & 0xff;
    this.length += 2;
  }

  writeString(text) {
    this.ensureCapacity(text.length);
    for (let i = 0; i < text.length; i += 1) {
      this.buffer[this.length] = text.charCodeAt(i) & 0xff;
      this.length += 1;
    }
  }

  toUint8Array() {
    // Return a right-sized view (copy) of the written region.
    return this.buffer.slice(0, this.length);
  }
}

// ---- Median-cut color quantization ----------------------------------------

function sampleColors(frames, step) {
  // Collect opaque pixels (RGB) from every frame, subsampled for speed.
  const samples = [];
  for (const frame of frames) {
    const { data } = frame;
    for (let i = 0; i < data.length; i += 4 * step) {
      if (data[i + 3] < TRANSPARENT_ALPHA_THRESHOLD) {
        continue;
      }
      samples.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  return samples;
}

function medianCut(samples, maxColors) {
  if (samples.length === 0) {
    return [[0, 0, 0]];
  }

  let buckets = [samples];

  while (buckets.length < maxColors) {
    // Find the bucket with the largest color range on any channel.
    let targetIndex = -1;
    let targetChannel = 0;
    let largestRange = -1;

    for (let b = 0; b < buckets.length; b += 1) {
      const bucket = buckets[b];
      if (bucket.length < 2) {
        continue;
      }
      const min = [255, 255, 255];
      const max = [0, 0, 0];
      for (const color of bucket) {
        for (let c = 0; c < 3; c += 1) {
          if (color[c] < min[c]) min[c] = color[c];
          if (color[c] > max[c]) max[c] = color[c];
        }
      }
      for (let c = 0; c < 3; c += 1) {
        const range = max[c] - min[c];
        if (range > largestRange) {
          largestRange = range;
          targetIndex = b;
          targetChannel = c;
        }
      }
    }

    if (targetIndex < 0) {
      break; // No splittable bucket left.
    }

    const bucket = buckets[targetIndex];
    bucket.sort((a, b) => a[targetChannel] - b[targetChannel]);
    const mid = Math.floor(bucket.length / 2);
    const lower = bucket.slice(0, mid);
    const upper = bucket.slice(mid);
    buckets.splice(targetIndex, 1, lower, upper);
  }

  // Average each bucket to its representative color.
  return buckets.map((bucket) => {
    const total = [0, 0, 0];
    for (const color of bucket) {
      total[0] += color[0];
      total[1] += color[1];
      total[2] += color[2];
    }
    const count = bucket.length || 1;
    return [Math.round(total[0] / count), Math.round(total[1] / count), Math.round(total[2] / count)];
  });
}

// Build a 256-entry global color table. We reserve the LAST index for
// transparency so transparent areas have a stable, unused-by-pixels slot.
function buildPalette(frames) {
  const samples = sampleColors(frames, 7);
  // Leave room for the reserved transparent slot.
  const colors = medianCut(samples, 255);

  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < colors.length && i < 255; i += 1) {
    table[i * 3] = colors[i][0];
    table[i * 3 + 1] = colors[i][1];
    table[i * 3 + 2] = colors[i][2];
  }
  const transparentIndex = 255;
  // Transparent slot is left at 0,0,0 — never matched by opaque pixels.
  return { table, colorCount: Math.max(1, colors.length), transparentIndex };
}

function nearestColorIndex(palette, colorCount, r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < colorCount; i += 1) {
    const dr = r - palette[i * 3];
    const dg = g - palette[i * 3 + 1];
    const db = b - palette[i * 3 + 2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
      if (dist === 0) break;
    }
  }
  return best;
}

// Map a frame's pixels to palette indices. Transparent pixels -> transparentIndex.
function mapFrame(frame, palette, colorCount, transparentIndex, cache) {
  const { data, width, height } = frame;
  const indices = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < indices.length; p += 1, i += 4) {
    if (data[i + 3] < TRANSPARENT_ALPHA_THRESHOLD) {
      indices[p] = transparentIndex;
      continue;
    }
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = (r << 16) | (g << 8) | b;
    let idx = cache.get(key);
    if (idx === undefined) {
      idx = nearestColorIndex(palette, colorCount, r, g, b);
      cache.set(key, idx);
    }
    indices[p] = idx;
  }
  return indices;
}

// ---- LZW compression (GIF variable-width) ---------------------------------

function lzwEncode(indices, minCodeSize) {
  const out = new ByteBuffer();

  // Sub-block packer: GIF image data is a series of <=255-byte sub-blocks.
  let blockBytes = [];
  const flushBlock = () => {
    if (blockBytes.length === 0) return;
    out.writeByte(blockBytes.length);
    out.writeBytes(blockBytes);
    blockBytes = [];
  };
  const pushByte = (byte) => {
    blockBytes.push(byte & 0xff);
    if (blockBytes.length === 255) {
      flushBlock();
    }
  };

  // Bit packer (LSB-first, as GIF requires).
  let bitBuffer = 0;
  let bitCount = 0;
  const writeCode = (code, size) => {
    bitBuffer |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      pushByte(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();
  const resetDict = () => {
    dict = new Map();
    nextCode = eoiCode + 1;
    codeSize = minCodeSize + 1;
  };

  out.writeByte(minCodeSize);
  writeCode(clearCode, codeSize);

  if (indices.length > 0) {
    let current = indices[0];
    for (let i = 1; i < indices.length; i += 1) {
      const next = indices[i];
      const key = current * 4096 + next; // combined key (indices < 256)
      if (dict.has(key)) {
        current = dict.get(key);
      } else {
        writeCode(current, codeSize);
        dict.set(key, nextCode);
        nextCode += 1;
        if (nextCode > (1 << codeSize) && codeSize < 12) {
          codeSize += 1;
        }
        if (nextCode >= 4096) {
          writeCode(clearCode, codeSize);
          resetDict();
        }
        current = next;
      }
    }
    writeCode(current, codeSize);
  }

  writeCode(eoiCode, codeSize);
  // Flush remaining bits.
  if (bitCount > 0) {
    pushByte(bitBuffer & 0xff);
  }
  flushBlock();
  out.writeByte(0x00); // Block terminator.

  return out.toUint8Array();
}

// ---- Frame normalization ---------------------------------------------------

// Render a source (canvas / ImageData / {canvas}) to ImageData at the target
// size. Frames can be canvases of any size; they are scaled to width/height.
function toImageData(source, width, height) {
  if (source && source.data && typeof source.width === "number") {
    // Already ImageData of the right size.
    if (source.width === width && source.height === height) {
      return source;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (source instanceof ImageData) {
    const tmp = document.createElement("canvas");
    tmp.width = source.width;
    tmp.height = source.height;
    tmp.getContext("2d").putImageData(source, 0, 0);
    context.drawImage(tmp, 0, 0, width, height);
  } else {
    context.drawImage(source, 0, 0, width, height);
  }
  return context.getImageData(0, 0, width, height);
}

// ---- Public API -------------------------------------------------------------

// frames: array of { source (canvas/ImageData), delayMs }
// options: { width, height }
// Returns a Uint8Array containing a valid looping GIF89a.
export function encodeGif(frames, { width, height } = {}) {
  if (!frames || frames.length === 0) {
    throw new Error("encodeGif requires at least one frame");
  }

  const targetWidth = Math.max(1, Math.round(width || frames[0].source.width || 320));
  const targetHeight = Math.max(1, Math.round(height || frames[0].source.height || 240));

  const imageFrames = frames.map((frame) => ({
    ...toImageData(frame.source, targetWidth, targetHeight),
    delayMs: frame.delayMs || 100,
  }));

  const { table, colorCount, transparentIndex } = buildPalette(imageFrames);

  // GIF color tables must be a power of two; we always emit a full 256 table.
  const colorTableSize = 7; // 2^(7+1) = 256 entries.

  const out = new ByteBuffer();

  // Header.
  out.writeString("GIF89a");

  // Logical Screen Descriptor.
  out.writeShort(targetWidth);
  out.writeShort(targetHeight);
  // Packed: global color table flag (1), color resolution (7), sort (0), size.
  out.writeByte(0b10000000 | (0b111 << 4) | colorTableSize);
  out.writeByte(0); // Background color index.
  out.writeByte(0); // Pixel aspect ratio.

  // Global Color Table (256 * 3 bytes).
  out.writeBytes(table);

  // NETSCAPE2.0 Application Extension for looping forever.
  out.writeByte(0x21); // Extension introducer.
  out.writeByte(0xff); // Application extension label.
  out.writeByte(0x0b); // Block size (11).
  out.writeString("NETSCAPE2.0");
  out.writeByte(0x03); // Sub-block size.
  out.writeByte(0x01); // Sub-block id.
  out.writeShort(0); // Loop count: 0 = forever.
  out.writeByte(0x00); // Block terminator.

  const cache = new Map();
  const minCodeSize = 8; // 256-color table -> 8-bit codes.

  for (const frame of imageFrames) {
    const delayCentis = Math.max(1, Math.round(frame.delayMs / 10));

    // Graphic Control Extension (delay + transparency).
    out.writeByte(0x21); // Extension introducer.
    out.writeByte(0xf9); // Graphic control label.
    out.writeByte(0x04); // Block size.
    // Packed: disposal method (2 = restore to background) + transparent flag.
    out.writeByte((0b010 << 2) | 0x01);
    out.writeShort(delayCentis);
    out.writeByte(transparentIndex);
    out.writeByte(0x00); // Block terminator.

    // Image Descriptor.
    out.writeByte(0x2c); // Image separator.
    out.writeShort(0); // Left.
    out.writeShort(0); // Top.
    out.writeShort(targetWidth);
    out.writeShort(targetHeight);
    out.writeByte(0x00); // No local color table.

    const indices = mapFrame(frame, table, colorCount, transparentIndex, cache);
    const lzw = lzwEncode(indices, minCodeSize);
    out.writeBytes(lzw);
  }

  out.writeByte(0x3b); // Trailer.

  return out.toUint8Array();
}

// Validate the broad structure of an encoded GIF. Used by tests / sanity checks.
export function isValidGif(bytes) {
  if (!bytes || bytes.length < 14) {
    return false;
  }
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (header !== "GIF89a") {
    return false;
  }
  if (bytes[bytes.length - 1] !== 0x3b) {
    return false;
  }
  return true;
}
