// Self-contained animated GIF89a encoder. No npm dependency.
//
// Operates on raw RGBA8888 frames (Uint8Array, length = width * height * 4) as
// produced by Skia's `SkImage.readPixels({ colorType: RGBA_8888, alphaType:
// Unpremul })`. Produces a valid looping GIF:
//   - GIF89a header + logical screen descriptor
//   - global color table built via median-cut over all frames (<= 256 colors)
//   - NETSCAPE2.0 application extension (infinite loop)
//   - one graphic control extension + LZW-compressed image per frame
//   - 0x3B trailer
//
// Transparency: fully/partly transparent source pixels (alpha < threshold) are
// mapped to a reserved transparent palette index so loops with a clear paper
// background animate over transparency rather than a flat fill.

export type RgbaFrame = {
  width: number;
  height: number;
  // RGBA, row-major, 4 bytes per pixel.
  data: Uint8Array;
  delayMs: number;
};

const ALPHA_THRESHOLD = 128;

// --- Median-cut color quantization -----------------------------------------

type Box = {
  pixels: number[]; // packed 0xRRGGBB values
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
};

function makeBox(pixels: number[]): Box {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (const packed of pixels) {
    const r = (packed >> 16) & 0xff;
    const g = (packed >> 8) & 0xff;
    const b = packed & 0xff;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return { pixels, rMin, rMax, gMin, gMax, bMin, bMax };
}

function longestAxis(box: Box): "r" | "g" | "b" {
  const r = box.rMax - box.rMin;
  const g = box.gMax - box.gMin;
  const b = box.bMax - box.bMin;
  if (r >= g && r >= b) return "r";
  if (g >= b) return "g";
  return "b";
}

function averageColor(pixels: number[]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const packed of pixels) {
    r += (packed >> 16) & 0xff;
    g += (packed >> 8) & 0xff;
    b += packed & 0xff;
  }
  const n = Math.max(1, pixels.length);
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

// Build a palette of up to `maxColors` from the opaque pixels of all frames.
function medianCut(opaquePixels: number[], maxColors: number): Array<[number, number, number]> {
  if (opaquePixels.length === 0) {
    return [[0, 0, 0]];
  }

  let boxes: Box[] = [makeBox(opaquePixels)];

  while (boxes.length < maxColors) {
    // Pick the box with the largest single-axis spread to split.
    let target = -1;
    let targetSpread = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.pixels.length < 2) continue;
      const spread = Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
      if (spread > targetSpread) {
        targetSpread = spread;
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const axis = longestAxis(box);
    const shift = axis === "r" ? 16 : axis === "g" ? 8 : 0;
    const sorted = [...box.pixels].sort((a, b) => ((a >> shift) & 0xff) - ((b >> shift) & 0xff));
    const mid = Math.floor(sorted.length / 2);
    const lower = sorted.slice(0, mid);
    const upper = sorted.slice(mid);
    if (lower.length === 0 || upper.length === 0) break;

    boxes.splice(target, 1, makeBox(lower), makeBox(upper));
  }

  return boxes.map((box) => averageColor(box.pixels));
}

// --- Nearest-palette lookup with a small cache ------------------------------

function buildNearest(palette: Array<[number, number, number]>) {
  const cache = new Map<number, number>();
  return (r: number, g: number, b: number): number => {
    const key = (r << 16) | (g << 8) | b;
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i += 1) {
      const [pr, pg, pb] = palette[i];
      const dr = pr - r;
      const dg = pg - g;
      const db = pb - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    cache.set(key, best);
    return best;
  };
}

// --- LZW compression (GIF variable-width) -----------------------------------

function lzwCompress(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = new Map<string, number>();

  const resetDict = () => {
    dict = new Map<string, number>();
    for (let i = 0; i < clearCode; i += 1) {
      dict.set(String(i), i);
    }
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  };

  // Bit packing (LSB first, as GIF requires).
  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  const writeCode = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  resetDict();
  writeCode(clearCode);

  let current = String(indices[0]);
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const combined = `${current},${k}`;
    if (dict.has(combined)) {
      current = combined;
    } else {
      writeCode(dict.get(current)!);
      dict.set(combined, nextCode);
      nextCode += 1;
      if (nextCode > (1 << codeSize) && codeSize < 12) {
        codeSize += 1;
      }
      if (nextCode > 4095) {
        writeCode(clearCode);
        resetDict();
      }
      current = String(k);
    }
  }
  writeCode(dict.get(current)!);
  writeCode(endCode);

  // Flush remaining bits.
  if (bitCount > 0) {
    out.push(bitBuffer & 0xff);
  }
  return out;
}

// --- Byte writer ------------------------------------------------------------

class ByteWriter {
  private bytes: number[] = [];

  byte(value: number) {
    this.bytes.push(value & 0xff);
  }

  word(value: number) {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  string(text: string) {
    for (let i = 0; i < text.length; i += 1) {
      this.bytes.push(text.charCodeAt(i) & 0xff);
    }
  }

  raw(values: number[]) {
    for (const value of values) {
      this.bytes.push(value & 0xff);
    }
  }

  // Emit LZW data as GIF sub-blocks (max 255 bytes each, 0x00 terminator).
  subBlocks(data: number[]) {
    let offset = 0;
    while (offset < data.length) {
      const chunk = Math.min(255, data.length - offset);
      this.bytes.push(chunk);
      for (let i = 0; i < chunk; i += 1) {
        this.bytes.push(data[offset + i] & 0xff);
      }
      offset += chunk;
    }
    this.bytes.push(0x00);
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// --- Main encoder -----------------------------------------------------------

export function encodeGif(frames: RgbaFrame[]): Uint8Array {
  if (frames.length === 0) {
    throw new Error("Cannot encode a GIF with no frames.");
  }

  const width = frames[0].width;
  const height = frames[0].height;

  // Gather a sample of opaque colors across all frames for the global palette.
  // Reserve one slot for transparency, so quantize to at most 255 colors.
  const opaque: number[] = [];
  const sampleStride = 1; // every pixel; frames are small canvases.
  for (const frame of frames) {
    const { data } = frame;
    for (let p = 0; p < data.length; p += 4 * sampleStride) {
      if (data[p + 3] >= ALPHA_THRESHOLD) {
        opaque.push((data[p] << 16) | (data[p + 1] << 8) | data[p + 2]);
      }
    }
  }

  const palette = medianCut(opaque, 255);
  const nearest = buildNearest(palette);

  // The transparent index is the entry just after the real colors.
  const transparentIndex = palette.length;
  const colorCount = palette.length + 1; // +1 for transparent slot

  // GIF color tables must be a power of two in size, 2..256.
  let tableSize = 2;
  let colorBits = 1;
  while (tableSize < colorCount) {
    tableSize <<= 1;
    colorBits += 1;
  }

  const writer = new ByteWriter();

  // Header + logical screen descriptor.
  writer.string("GIF89a");
  writer.word(width);
  writer.word(height);
  // Packed: global color table flag (1), color resolution (colorBits-1),
  // sort (0), size of GCT (colorBits-1).
  writer.byte(0x80 | ((colorBits - 1) << 4) | (colorBits - 1));
  writer.byte(transparentIndex & 0xff); // background color index
  writer.byte(0x00); // pixel aspect ratio

  // Global color table.
  for (let i = 0; i < tableSize; i += 1) {
    if (i < palette.length) {
      writer.raw(palette[i]);
    } else {
      writer.raw([0, 0, 0]);
    }
  }

  // NETSCAPE2.0 looping extension (0 = loop forever).
  writer.byte(0x21); // extension introducer
  writer.byte(0xff); // application extension label
  writer.byte(0x0b); // block size (11)
  writer.string("NETSCAPE2.0");
  writer.byte(0x03); // sub-block size
  writer.byte(0x01); // sub-block id
  writer.word(0x0000); // loop count: 0 = infinite
  writer.byte(0x00); // block terminator

  const minCodeSize = Math.max(2, colorBits);

  for (const frame of frames) {
    const { data } = frame;
    const pixelCount = width * height;
    const indices = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; i += 1) {
      const p = i * 4;
      if (data[p + 3] < ALPHA_THRESHOLD) {
        indices[i] = transparentIndex;
      } else {
        indices[i] = nearest(data[p], data[p + 1], data[p + 2]);
      }
    }

    // Graphic control extension (delay in centiseconds, transparency on).
    const delayCs = Math.max(2, Math.round(frame.delayMs / 10));
    writer.byte(0x21); // extension introducer
    writer.byte(0xf9); // graphic control label
    writer.byte(0x04); // block size
    writer.byte(0x09); // packed: disposal=2 (restore bg), transparent flag=1
    writer.word(delayCs);
    writer.byte(transparentIndex & 0xff); // transparent color index
    writer.byte(0x00); // block terminator

    // Image descriptor.
    writer.byte(0x2c);
    writer.word(0); // left
    writer.word(0); // top
    writer.word(width);
    writer.word(height);
    writer.byte(0x00); // no local color table

    // LZW image data.
    writer.byte(minCodeSize);
    const compressed = lzwCompress(indices, minCodeSize);
    writer.subBlocks(compressed);
  }

  writer.byte(0x3b); // trailer
  return writer.toUint8Array();
}

// Base64-encode a byte array without relying on Buffer (RN-safe).
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let result = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    result += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return result;
}
