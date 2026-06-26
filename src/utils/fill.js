// Tolerance-based scanline flood fill operating on a layer's ImageData.

function hexToRgba(hex) {
  let value = hex.replace("#", "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((char) => char + char)
      .join("");
  }
  const int = parseInt(value, 16);
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
    a: 255,
  };
}

function colorMatches(data, offset, target, tolerance) {
  const dr = data[offset] - target.r;
  const dg = data[offset + 1] - target.g;
  const db = data[offset + 2] - target.b;
  const da = data[offset + 3] - target.a;
  // Squared distance keeps the inner loop cheap. tolerance is 0..255 per channel.
  const limit = tolerance * tolerance * 4;
  return dr * dr + dg * dg + db * db + da * da <= limit;
}

// Flood fill `canvas` starting at (startX, startY) with `hexColor`.
// tolerance: 0..1 (mapped to a per-channel threshold). opacity: 0..1.
export function floodFill(canvas, startX, startY, hexColor, { tolerance = 0.12, opacity = 1 } = {}) {
  const width = canvas.width;
  const height = canvas.height;
  const x = Math.round(startX);
  const y = Math.round(startY);

  if (x < 0 || y < 0 || x >= width || y >= height) {
    return false;
  }

  const context = canvas.getContext("2d");
  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const startOffset = (y * width + x) * 4;
  const target = {
    r: data[startOffset],
    g: data[startOffset + 1],
    b: data[startOffset + 2],
    a: data[startOffset + 3],
  };

  const fill = hexToRgba(hexColor);
  const fillAlpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  const threshold = Math.max(0, Math.min(1, tolerance)) * 255;

  // No-op if the clicked pixel already matches the fill exactly.
  if (target.r === fill.r && target.g === fill.g && target.b === fill.b && target.a === fillAlpha) {
    return false;
  }

  const visited = new Uint8Array(width * height);
  const stack = [[x, y]];
  let touched = false;
  // Track the filled region's bounding box so we only putImageData the dirty
  // sub-rect instead of the whole 1600x1200 buffer (W10).
  let minX = x;
  let minY = y;
  let maxX = x;
  let maxY = y;

  while (stack.length > 0) {
    const [px, py] = stack.pop();
    let left = px;

    // Walk left to the span start.
    while (left >= 0) {
      const offset = (py * width + left) * 4;
      if (visited[py * width + left] || !colorMatches(data, offset, target, threshold)) {
        break;
      }
      left -= 1;
    }
    left += 1;

    let spanUp = false;
    let spanDown = false;
    let cx = left;

    while (cx < width) {
      const pixelIndex = py * width + cx;
      const offset = pixelIndex * 4;
      if (visited[pixelIndex] || !colorMatches(data, offset, target, threshold)) {
        break;
      }

      visited[pixelIndex] = 1;
      data[offset] = fill.r;
      data[offset + 1] = fill.g;
      data[offset + 2] = fill.b;
      data[offset + 3] = fillAlpha;
      touched = true;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      if (py > 0) {
        const upIndex = (py - 1) * width + cx;
        const upMatch = !visited[upIndex] && colorMatches(data, upIndex * 4, target, threshold);
        if (upMatch && !spanUp) {
          stack.push([cx, py - 1]);
          spanUp = true;
        } else if (!upMatch) {
          spanUp = false;
        }
      }

      if (py < height - 1) {
        const downIndex = (py + 1) * width + cx;
        const downMatch = !visited[downIndex] && colorMatches(data, downIndex * 4, target, threshold);
        if (downMatch && !spanDown) {
          stack.push([cx, py + 1]);
          spanDown = true;
        } else if (!downMatch) {
          spanDown = false;
        }
      }

      cx += 1;
    }
  }

  if (touched) {
    // putImageData's dirty-rect overload writes only the filled bounding box
    // back to the canvas, leaving the rest of the (unmodified) buffer alone.
    const dirtyW = maxX - minX + 1;
    const dirtyH = maxY - minY + 1;
    context.putImageData(image, 0, 0, minX, minY, dirtyW, dirtyH);
  }

  return touched;
}
