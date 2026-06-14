import { useRef, useEffect, useState, useCallback } from 'react';
import { BRUSH_TYPES } from '../utils/constants';
import { PAINT_TYPES, PAINT_PROPERTIES } from '../utils/paintTypes';
import { mixPigments, hexToRgb, rgbToHex } from '../utils/colorMixer';

function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

function quadraticPoint(start, control, end, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
    y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
  };
}

function distanceBetween(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// In-place separable box blur on RGBA pixel data. Uses a sliding-window running
// sum so cost is O(w*h) independent of radius. Clamp-to-edge at the borders.
function separableBoxBlur(data, w, h, radius) {
  const span = radius * 2 + 1;
  const tmp = new Float32Array(data.length);

  // Horizontal pass: data -> tmp
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = k < 0 ? 0 : k >= w ? w - 1 : k;
        sum += data[row + xx * 4 + c];
      }
      for (let x = 0; x < w; x++) {
        tmp[row + x * 4 + c] = sum / span;
        const xOut = x - radius < 0 ? 0 : x - radius;
        const xInRaw = x + radius + 1;
        const xIn = xInRaw >= w ? w - 1 : xInRaw;
        sum += data[row + xIn * 4 + c] - data[row + xOut * 4 + c];
      }
    }
  }

  // Vertical pass: tmp -> data
  for (let x = 0; x < w; x++) {
    const col = x * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = k < 0 ? 0 : k >= h ? h - 1 : k;
        sum += tmp[yy * w * 4 + col + c];
      }
      for (let y = 0; y < h; y++) {
        data[y * w * 4 + col + c] = Math.round(sum / span);
        const yOut = y - radius < 0 ? 0 : y - radius;
        const yInRaw = y + radius + 1;
        const yIn = yInRaw >= h ? h - 1 : yInRaw;
        sum += tmp[yIn * w * 4 + col + c] - tmp[yOut * w * 4 + col + c];
      }
    }
  }
}

function sampleUnderlyingColor(ctx, x, y, sampleSize) {
  const r = Math.max(1, Math.floor(sampleSize));
  const sx = Math.max(0, Math.floor(x - r / 2));
  const sy = Math.max(0, Math.floor(y - r / 2));
  const sw = Math.min(r * 2, ctx.canvas.width - sx);
  const sh = Math.min(r * 2, ctx.canvas.height - sy);
  if (sw <= 0 || sh <= 0) return null;
  try {
    const imgData = ctx.getImageData(sx, sy, sw, sh);
    let cr = 0, cg = 0, cb = 0, count = 0;
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      cr += d[i];
      cg += d[i + 1];
      cb += d[i + 2];
      count++;
    }
    if (count === 0) return null;
    return rgbToHex(
      Math.round(cr / count),
      Math.round(cg / count),
      Math.round(cb / count)
    );
  } catch (e) {
    return null;
  }
}

export const useDrawing = (
  canvasRef,
  currentBrush,
  brushSize,
  selectedColor,
  brushOpacity,
  brushVariation,
  isReady,
  paintType,
  onStrokeComplete,
  onDrawStart,
  viewportRef,
  paintMinZoom,
  onChatClick,
  onMemeClick,
  onStrokeLive
) => {
  const [isEraser, setIsEraser] = useState(false);
  const [lineStart, setLineStart] = useState(null);
  const isPainting = useRef(false);
  const isMemeStamping = useRef(false);
  const lastPos = useRef(null);
  const currentStroke = useRef(null);

  // Graffiti drips: paint that runs down the wall after spraying.
  const dripsRef = useRef([]);
  const dripRafRef = useRef(null);
  const lastLiveSend = useRef(0);
  const sentPointCount = useRef(0);
  const strokeIdRef = useRef('');

  const drawPoint = useCallback((ctx, x, y, brush, size, color, opacity, variation) => {
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (brush) {
      case BRUSH_TYPES.ROUND:
      case BRUSH_TYPES.PEN:
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        break;

      case BRUSH_TYPES.SQUARE:
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
        break;

      case BRUSH_TYPES.PENCIL:
        ctx.globalAlpha = opacity * 0.5;
        ctx.lineWidth = Math.max(1, size * 0.25);
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, size * 0.12), 0, Math.PI * 2);
        ctx.fill();
        for (let i = 0; i < 3; i++) {
          const ox = (Math.random() - 0.5) * size * 0.5;
          const oy = (Math.random() - 0.5) * size * 0.5;
          ctx.globalAlpha = opacity * 0.3;
          ctx.beginPath();
          ctx.arc(x + ox, y + oy, Math.max(0.5, size * 0.05), 0, Math.PI * 2);
          ctx.fill();
        }
        break;

      case BRUSH_TYPES.SPRAY:
        drawSpray(ctx, x, y, size, opacity, color, variation, false);
        break;

      case BRUSH_TYPES.AIRBRUSH:
        drawAirbrush(ctx, x, y, size, opacity, color, variation);
        break;

      case BRUSH_TYPES.PALETTE_KNIFE:
        drawPaletteKnife(ctx, x, y, size, opacity, color);
        break;

      case BRUSH_TYPES.BLUR:
        drawBlur(ctx, x, y, size, opacity);
        break;

      case BRUSH_TYPES.SMUDGE:
        drawSmudge(ctx, x, y, size, opacity);
        break;

      case BRUSH_TYPES.WET_BRUSH:
        drawWetBrush(ctx, x, y, size, opacity, color, variation);
        break;

      case BRUSH_TYPES.SPONGE:
        drawSponge(ctx, x, y, size, opacity, color, variation);
        break;

      case BRUSH_TYPES.ERASER:
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        break;

      default:
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
    }
  }, [paintType]);

  function drawSpray(ctx, x, y, size, opacity, color, variation, airbrush) {
    const density = Math.floor(size * 2 * variation);

    if (airbrush) {
      // Particle alpha fades with radius, so these can't share one fill.
      ctx.globalAlpha = opacity * 0.02;
      for (let i = 0; i < density; i++) {
        const u = Math.random() + Math.random() + Math.random();
        const radius = (u / 3) * size;
        const angle = Math.random() * Math.PI * 2;
        const dx = x + radius * Math.cos(angle);
        const dy = y + radius * Math.sin(angle);
        const particleSize = Math.max(0.3, Math.random() * 1.0);
        ctx.globalAlpha = opacity * 0.03 * (1 - radius / size);
        ctx.beginPath();
        ctx.arc(dx, dy, particleSize, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }

    // Constant alpha → batch every speck into a single path and fill once.
    ctx.globalAlpha = opacity * 0.18;
    ctx.beginPath();
    for (let i = 0; i < density; i++) {
      const radius = Math.random() * size;
      const angle = Math.random() * Math.PI * 2;
      const dx = x + radius * Math.cos(angle);
      const dy = y + radius * Math.sin(angle);
      const particleSize = Math.max(0.5, Math.random() * 1.5);
      ctx.moveTo(dx + particleSize, dy);
      ctx.arc(dx, dy, particleSize, 0, Math.PI * 2);
    }
    ctx.fill();
  }

  // Advance every active drip one frame, baking the new run segment onto the
  // canvas. When a drip finishes, it leaves a rounded droplet at its tip.
  const animateDrips = () => {
    const canvas = canvasRef.current;
    if (!canvas) { dripRafRef.current = null; return; }
    const ctx = canvas.getContext('2d');
    const drips = dripsRef.current;

    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';

    for (const d of drips) {
      if (d.done) continue;
      const prevLen = d.len;
      d.len = Math.min(d.maxLen, d.len + d.speed);
      d.speed *= 0.99; // paint slows as it runs out of momentum

      const px = d.x + Math.sin(prevLen * 0.04 + d.phase) * d.wobble + d.drift * (prevLen / d.maxLen);
      const py = d.y + prevLen;
      const nx = d.x + Math.sin(d.len * 0.04 + d.phase) * d.wobble + d.drift * (d.len / d.maxLen);
      const ny = d.y + d.len;
      const w = Math.max(0.7, d.width * (1 - 0.45 * (d.len / d.maxLen)));

      ctx.strokeStyle = `rgba(${d.r},${d.g},${d.b},${d.opacity})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      d.headX = nx; d.headY = ny; d.headW = w;
      if (d.len >= d.maxLen || d.speed < 0.15) {
        d.done = true;
        // A heavier droplet pools at the bottom of the run.
        ctx.fillStyle = `rgba(${d.r},${d.g},${d.b},${Math.min(1, d.opacity * 1.25)})`;
        ctx.beginPath();
        ctx.arc(d.headX, d.headY, d.headW * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    dripsRef.current = drips.filter((d) => !d.done);
    dripRafRef.current = dripsRef.current.length > 0
      ? requestAnimationFrame(animateDrips)
      : null;
  };

  // Occasionally start a run of paint dripping down from a sprayed spot.
  const maybeSpawnDrip = (x, y, size, color, opacity, chanceScale) => {
    if (dripsRef.current.length > 60) return; // cap for perf
    const chance = opacity * brushVariation * 0.05 * chanceScale;
    if (Math.random() > chance) return;

    const rgb = hexToRgb(color) || { r: 0, g: 0, b: 0 };
    dripsRef.current.push({
      r: rgb.r, g: rgb.g, b: rgb.b,
      x: x + (Math.random() - 0.5) * size * 0.5,
      y: y + size * 0.2,
      len: 0,
      maxLen: size * (1.5 + Math.random() * 4.5),
      width: Math.max(1.4, size * (0.08 + Math.random() * 0.14)),
      opacity: Math.min(0.9, opacity * (0.55 + Math.random() * 0.4)),
      speed: 2.2 + Math.random() * 3.5,
      drift: (Math.random() - 0.5) * size * 0.5,
      wobble: size * (0.04 + Math.random() * 0.1),
      phase: Math.random() * Math.PI * 2,
      done: false,
      headX: x, headY: y, headW: 1,
    });
    if (!dripRafRef.current) {
      dripRafRef.current = requestAnimationFrame(animateDrips);
    }
  };

  // Cancel and clear all drips (used when the mural is cleared/replayed).
  const clearDrips = useCallback(() => {
    if (dripRafRef.current) {
      cancelAnimationFrame(dripRafRef.current);
      dripRafRef.current = null;
    }
    dripsRef.current = [];
  }, []);

  function drawAirbrush(ctx, x, y, size, opacity, color, variation) {
    maybeSpawnDrip(x, y, size, color, opacity, 1);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
    gradient.addColorStop(0, color);
    gradient.addColorStop(0.3, color);
    gradient.addColorStop(0.7, color);
    gradient.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.globalAlpha = opacity * variation * 0.15;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();

    drawSpray(ctx, x, y, size * 0.6, opacity, color, variation, true);
  }

  function drawPaletteKnife(ctx, x, y, size, opacity, color, angleOverride = null) {
    // Sample underlying color for realistic smearing
    const underlying = sampleUnderlyingColor(ctx, x, y, size * 0.5);

    const angle = angleOverride ?? (lastPos.current
      ? Math.atan2(y - lastPos.current.y, x - lastPos.current.x)
      : Math.random() * Math.PI * 2);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    const w = size * 0.55;
    const h = size * 1.75;

    // Scrape effect: erase a thin line to reveal canvas
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = opacity * 0.12;
    ctx.fillRect(-w * 1.3, -0.5, w * 2.6, 1);
    ctx.fillRect(-w * 1.3, -h / 2 + 1.5, w * 2.6, 0.8);

    ctx.globalCompositeOperation = 'source-over';

    // Paint deposit: the knife leaves a smear of paint
    const smearColor = underlying && underlying !== '#ffffff'
      ? mixPigments(underlying, color, opacity * 0.5)
      : color;

    ctx.globalAlpha = opacity * 0.62;
    ctx.fillStyle = smearColor;
    ctx.fillRect(-w, -h / 2, w * 2, h);

    // Edge highlight (oil paint ridge)
    ctx.globalAlpha = opacity * 0.72;
    ctx.fillStyle = color;
    ctx.fillRect(-w * 1.1, -0.8, w * 2.2, 1.6);
    ctx.fillRect(-w * 1.1, -h / 2 + 0.5, w * 2.2, 0.7);

    ctx.restore();
  }

  function drawBlur(ctx, x, y, size, opacity) {
    const r = Math.ceil(size * 0.6);
    const sx = Math.max(0, Math.floor(x - r));
    const sy = Math.max(0, Math.floor(y - r));
    const sw = Math.min(r * 2, ctx.canvas.width - sx);
    const sh = Math.min(r * 2, ctx.canvas.height - sy);
    if (sw <= 0 || sh <= 0) return;

    try {
      const imgData = ctx.getImageData(sx, sy, sw, sh);
      // Separable box blur — O(w*h) regardless of radius (was O(w*h*r^2),
      // which froze the tab on large brushes). Two box passes ≈ gaussian.
      const radius = Math.max(1, Math.floor(r * 0.35));
      separableBoxBlur(imgData.data, sw, sh, radius);
      separableBoxBlur(imgData.data, sw, sh, radius);
      ctx.putImageData(imgData, sx, sy);
    } catch (e) {
      // ignore
    }
  }

  function drawSmudge(ctx, x, y, size, opacity) {
    if (!lastPos.current) return;

    const lerpFactor = opacity * 0.6;
    const from = sampleUnderlyingColor(ctx, lastPos.current.x, lastPos.current.y, size * 0.4);
    const to = sampleUnderlyingColor(ctx, x, y, size * 0.4);

    let smearColor;
    if (from && to) {
      smearColor = mixPigments(from, to, lerpFactor);
    } else if (from) {
      smearColor = from;
    } else if (to) {
      smearColor = to;
    } else {
      // Nothing to sample — draw nothing
      return;
    }

    ctx.globalAlpha = opacity * 0.7;
    ctx.fillStyle = smearColor;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.35, 0, Math.PI * 2);
    ctx.fill();

    // Streak mark toward previous position
    if (lastPos.current) {
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(x, y);
      ctx.lineWidth = size * 0.15;
      ctx.strokeStyle = smearColor;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  function drawWetBrush(ctx, x, y, size, opacity, color, variation) {
    // Wet paint runs readily — a touch more drip-prone than the airbrush.
    maybeSpawnDrip(x, y, size, color, opacity, 1.4);
    // Wet brush: soft circle with variable opacity that spreads
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size * 0.55);
    const rgb = hexToRgb(color);

    // Concentrated color at center, fading to water at edges
    gradient.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${opacity * 0.9})`);
    gradient.addColorStop(0.4, `rgba(${rgb.r},${rgb.g},${rgb.b},${opacity * 0.6})`);
    gradient.addColorStop(0.7, `rgba(${rgb.r},${rgb.g},${rgb.b},${opacity * 0.25})`);
    gradient.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);

    ctx.globalAlpha = 1;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.55, 0, Math.PI * 2);
    ctx.fill();

    // Edge darkening for watercolor effect
    const paintProps = PAINT_PROPERTIES[paintType] || PAINT_PROPERTIES[PAINT_TYPES.NONE];
    if (paintProps.edgeDarkening) {
      ctx.globalAlpha = opacity * 0.35;
      ctx.strokeStyle = color;
      ctx.lineWidth = size * 0.12;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.52, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Granulation texture
    if (paintProps.granulation > 0) {
      ctx.globalAlpha = opacity * paintProps.granulation * 0.15;
      for (let i = 0; i < Math.floor(size * 1.5); i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * size * 0.5;
        const dx = x + radius * Math.cos(angle);
        const dy = y + radius * Math.sin(angle);
        ctx.beginPath();
        ctx.arc(dx, dy, Math.max(0.2, Math.random() * 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawSponge(ctx, x, y, size, opacity, color, variation) {
    // Sponge: dabbing textured application with irregular holes
    const density = Math.floor(size * variation * 3);
    ctx.globalAlpha = opacity * 0.4;

    for (let i = 0; i < density; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * size * 0.5;
      const dx = x + radius * Math.cos(angle);
      const dy = y + radius * Math.sin(angle);

      // Irregular sponge shapes
      const spotSize = Math.max(1, Math.random() * size * 0.2);
      ctx.beginPath();
      // Create irregular polygon for sponge texture
      const sides = 5 + Math.floor(Math.random() * 5);
      for (let s = 0; s < sides; s++) {
        const sa = (s / sides) * Math.PI * 2;
        const sr = spotSize * (0.6 + Math.random() * 0.4);
        const sx = dx + Math.cos(sa) * sr;
        const sy = dy + Math.sin(sa) * sr;
        if (s === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Overlay dark spots for sponge texture
    ctx.globalAlpha = opacity * 0.2;
    const rgb = hexToRgb(color);
    const darkened = rgbToHex(
      Math.max(0, rgb.r - 40),
      Math.max(0, rgb.g - 40),
      Math.max(0, rgb.b - 40)
    );
    ctx.fillStyle = darkened;
    for (let i = 0; i < Math.floor(density * 0.4); i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * size * 0.5;
      const dx = x + radius * Math.cos(angle);
      const dy = y + radius * Math.sin(angle);
      ctx.beginPath();
      ctx.arc(dx, dy, Math.max(0.5, Math.random() * size * 0.08), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const drawLine = useCallback((ctx, x1, y1, x2, y2, brush, size, color, opacity, variation) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(0.8, size / 5);
    const numSteps = Math.max(1, Math.floor(distance / step));

    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;
      drawPoint(ctx, x, y, brush, size, color, opacity, variation);
    }
  }, [drawPoint]);

  const drawVectorLine = useCallback((ctx, start, end, size, color, opacity) => {
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.restore();
  }, []);

  const drawSmoothLine = useCallback((ctx, p0, p1, p2, brush, size, color, opacity, variation) => {
    const start = midpoint(p0, p1);
    const end = midpoint(p1, p2);
    const approxLength = distanceBetween(start, p1) + distanceBetween(p1, end);
    const step = Math.max(0.7, size / 5);
    const samples = Math.max(3, Math.ceil(approxLength / step));

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = quadraticPoint(start, p1, end, t);
      drawPoint(ctx, p.x, p.y, brush, size, color, opacity, variation);
    }
  }, [drawPoint]);

  const drawSmoothPaletteKnife = useCallback((ctx, p0, p1, p2, size, opacity, color) => {
    const start = midpoint(p0, p1);
    const end = midpoint(p1, p2);
    const approxLength = distanceBetween(start, p1) + distanceBetween(p1, end);
    const samples = Math.max(4, Math.ceil(approxLength / Math.max(2, size / 3)));

    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const p = quadraticPoint(start, p1, end, t);
      const pNext = quadraticPoint(start, p1, end, Math.min(1, t + 1 / samples));
      const angle = Math.atan2(pNext.y - p.y, pNext.x - p.x);
      drawPaletteKnife(ctx, p.x, p.y, size, opacity, color, angle);
    }
  }, []);

  const startPainting = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas || !isReady) return;

    const vp = viewportRef?.current;
    if (!vp) return;

    const rect = canvas.getBoundingClientRect();
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;

    const maxDim = Math.max(rect.width, rect.height);
    const scale = maxDim / (vp.zoom * rect.height);
    const x = vp.x + (relX - rect.width / 2) * scale;
    const y = vp.y + (relY - rect.height / 2) * scale;

    if (currentBrush === BRUSH_TYPES.CHAT) {
      if (onChatClick) onChatClick(x, y);
      return;
    }

    if (currentBrush === BRUSH_TYPES.MEME) {
      const handled = onMemeClick?.(x, y, { phase: 'start', clientX, clientY });
      if (handled) {
        isMemeStamping.current = true;
        isPainting.current = true;
        lastPos.current = { x, y };
      }
      return;
    }

    if (currentBrush === BRUSH_TYPES.LINE) {
      if (!lineStart) {
        setLineStart({ x, y });
        const ctx = canvas.getContext('2d');
        if (ctx) {
          drawPoint(ctx, x, y, BRUSH_TYPES.ROUND, brushSize, selectedColor, brushOpacity, brushVariation);
        }
      } else {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          drawVectorLine(ctx, lineStart, { x, y }, brushSize, selectedColor, brushOpacity);
        }
        onStrokeComplete?.({
          type: BRUSH_TYPES.LINE,
          paintType,
          color: selectedColor,
          size: brushSize,
          opacity: brushOpacity,
          variation: brushVariation,
          strokeId: 'stroke_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
          points: [lineStart, { x, y }],
        });
        setLineStart(null);
      }
      return;
    }

    isPainting.current = true;
    lastPos.current = { x, y };
    lastLiveSend.current = 0;
    sentPointCount.current = 0;
    strokeIdRef.current = 'stroke_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);

    if (onDrawStart) onDrawStart();

    const resolvedType = currentBrush === BRUSH_TYPES.ERASER ? BRUSH_TYPES.ERASER : currentBrush;
    currentStroke.current = {
      type: resolvedType,
      paintType: currentBrush === BRUSH_TYPES.ERASER ? PAINT_TYPES.NONE : paintType,
      color: selectedColor,
      size: brushSize,
      opacity: brushOpacity,
      variation: brushVariation,
      strokeId: strokeIdRef.current,
      points: [{ x, y }],
    };

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      drawPoint(ctx, x, y, currentBrush, brushSize, selectedColor, brushOpacity, brushVariation);
      ctx.restore();
    }
  }, [canvasRef, isReady, currentBrush, lineStart, brushSize, selectedColor, brushOpacity, brushVariation, paintType, drawPoint, drawVectorLine, onChatClick, onMemeClick, onStrokeComplete, viewportRef]);

  const continuePainting = useCallback((clientX, clientY) => {
    if (!isPainting.current) return;

    const canvas = canvasRef.current;
    if (!canvas || !isReady) return;

    const vp = viewportRef?.current;
    if (!vp || vp.zoom < paintMinZoom) {
      isPainting.current = false;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    const maxDim = Math.max(rect.width, rect.height);
    const scale = maxDim / (vp.zoom * rect.height);
    const x = vp.x + (relX - rect.width / 2) * scale;
    const y = vp.y + (relY - rect.height / 2) * scale;

    if (currentBrush === BRUSH_TYPES.MEME && isMemeStamping.current) {
      onMemeClick?.(x, y, { phase: 'move', clientX, clientY });
      lastPos.current = { x, y };
      return;
    }

    if (!lastPos.current) {
      lastPos.current = { x, y };
      return;
    }

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      const strokePoints = currentStroke.current?.points || [];
      const hasCurve = strokePoints.length >= 2;
      const p0 = hasCurve ? strokePoints[strokePoints.length - 2] : null;
      const p1 = hasCurve ? strokePoints[strokePoints.length - 1] : lastPos.current;
      const p2 = { x, y };

      if (currentBrush === BRUSH_TYPES.PALETTE_KNIFE) {
        // Palette knife: smear existing paint then deposit new
        ctx.globalCompositeOperation = 'source-over';
        if (hasCurve) {
          drawSmearStroke(ctx, p0.x, p0.y, p2.x, p2.y, brushSize, brushOpacity);
          drawSmoothPaletteKnife(ctx, p0, p1, p2, brushSize, brushOpacity, selectedColor);
        } else {
          drawSmearStroke(ctx, lastPos.current.x, lastPos.current.y, x, y, brushSize, brushOpacity);
          drawLine(
            ctx,
            lastPos.current.x, lastPos.current.y,
            x, y,
            currentBrush,
            brushSize,
            selectedColor,
            brushOpacity,
            brushVariation
          );
        }

      } else if (currentBrush === BRUSH_TYPES.SMUDGE) {
        // Continuous smudge: drag underlying colors
        drawSmudgeStroke(ctx, lastPos.current.x, lastPos.current.y, x, y, brushSize, brushOpacity);
      } else if (currentBrush === BRUSH_TYPES.BLUR) {
        const dx = x - lastPos.current.x;
        const dy = y - lastPos.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const blurStep = Math.max(brushSize * 0.5, 10);
        const numSteps = Math.max(1, Math.floor(dist / blurStep));
        for (let i = 0; i <= numSteps; i++) {
          const t = i / numSteps;
          drawBlur(ctx,
            lastPos.current.x + dx * t,
            lastPos.current.y + dy * t,
            brushSize, brushOpacity);
        }
      } else {
        if (hasCurve) {
          drawSmoothLine(ctx, p0, p1, p2, currentBrush, brushSize, selectedColor, brushOpacity, brushVariation);
        } else {
          drawLine(
            ctx,
            lastPos.current.x, lastPos.current.y,
            x, y,
            currentBrush,
            brushSize,
            selectedColor,
            brushOpacity,
            brushVariation
          );
        }
      }
      ctx.restore();
    }

    if (currentStroke.current) {
      currentStroke.current.points.push({ x, y });
    }

    // Send live incremental stroke updates (throttled to ~40fps)
    if (onStrokeLive && currentStroke.current) {
      const now = performance.now();
      if (now - lastLiveSend.current >= 25) {
        const stroke = currentStroke.current;
        const newPoints = stroke.points.slice(sentPointCount.current);
        if (newPoints.length > 0) {
          onStrokeLive({
            strokeId: strokeIdRef.current,
            type: stroke.type,
            color: stroke.color,
            size: stroke.size,
            opacity: stroke.opacity,
            paintType: stroke.paintType,
            variation: stroke.variation,
            points: newPoints,
          });
          sentPointCount.current = stroke.points.length;
          lastLiveSend.current = now;
        }
      }
    }

    lastPos.current = { x, y };
  }, [canvasRef, isReady, currentBrush, brushSize, selectedColor, brushOpacity, brushVariation, drawLine, drawSmoothLine, drawSmoothPaletteKnife, onStrokeLive, onMemeClick]);

  function drawSmearStroke(ctx, x1, y1, x2, y2, size, opacity) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(1, size / 3);
    const numSteps = Math.max(1, Math.floor(dist / step));

    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;

      const sampleSize = Math.floor(size * 0.35);
      const sx = Math.max(0, Math.floor(x - sampleSize));
      const sy = Math.max(0, Math.floor(y - sampleSize));
      const sw = Math.min(sampleSize * 2, canvasRef.current.width - sx);
      const sh = Math.min(sampleSize * 2, canvasRef.current.height - sy);

      if (sw <= 0 || sh <= 0) continue;

      try {
        const imgData = ctx.getImageData(sx, sy, sw, sh);
        if (imgData && imgData.data.length > 0) {
          let r = 0, g = 0, b = 0, count = 0;
          const d = imgData.data;
          for (let j = 0; j < d.length; j += 4) {
            if (d[j + 3] > 10) {
              r += d[j];
              g += d[j + 1];
              b += d[j + 2];
              count++;
            }
          }
          if (count > 0) {
            r = Math.round(r / count);
            g = Math.round(g / count);
            b = Math.round(b / count);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
          }
        }
      } catch (e) {
        ctx.fillStyle = 'rgba(128,128,128,0.08)';
      }

      if (!ctx.fillStyle || ctx.fillStyle === '#000000') {
        ctx.fillStyle = 'rgba(128,128,128,0.08)';
      }
      ctx.globalAlpha = opacity * 0.12;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSmudgeStroke(ctx, x1, y1, x2, y2, size, opacity) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(1, size / 4);
    const numSteps = Math.max(1, Math.floor(dist / step));

    let carryColor = null;

    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;

      const current = sampleUnderlyingColor(ctx, x, y, size * 0.4);
      if (!current) continue;

      let smearColor;
      if (carryColor === null) {
        carryColor = current;
        smearColor = current;
      } else {
        smearColor = mixPigments(carryColor, current, opacity * 0.5);
        carryColor = smearColor;
      }

      ctx.globalAlpha = opacity * 0.55;
      ctx.fillStyle = smearColor;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.35, 0, Math.PI * 2);
      ctx.fill();

      if (i > 0) {
        const px = x1 + dx * ((i - 1) / numSteps);
        const py = y1 + dy * ((i - 1) / numSteps);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.lineWidth = size * 0.12;
        ctx.strokeStyle = smearColor;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
  }

  const stopPainting = useCallback(() => {
    if (isMemeStamping.current) {
      const endPos = lastPos.current;
      isPainting.current = false;
      isMemeStamping.current = false;
      lastPos.current = null;
      if (endPos) {
        onMemeClick?.(endPos.x, endPos.y, { phase: 'end' });
      }
      return null;
    }

    const stroke = currentStroke.current;
    if (stroke?.points?.length >= 2) {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      const prev = stroke.points[stroke.points.length - 2];
      const last = stroke.points[stroke.points.length - 1];
      const start = midpoint(prev, last);
      if (ctx) {
        ctx.save();
        if (stroke.type === BRUSH_TYPES.PALETTE_KNIFE) {
          drawLine(ctx, start.x, start.y, last.x, last.y, stroke.type, stroke.size, stroke.color, stroke.opacity, stroke.variation);
        } else if (stroke.type !== BRUSH_TYPES.SMUDGE && stroke.type !== BRUSH_TYPES.BLUR) {
          drawLine(ctx, start.x, start.y, last.x, last.y, stroke.type, stroke.size, stroke.color, stroke.opacity, stroke.variation);
        }
        ctx.restore();
      }
    }

    isPainting.current = false;
    lastPos.current = null;
    currentStroke.current = null;

    // Flush any remaining live points before returning the stroke
    if (onStrokeLive && stroke && sentPointCount.current < stroke.points.length) {
      onStrokeLive({
        strokeId: strokeIdRef.current,
        type: stroke.type,
        color: stroke.color,
        size: stroke.size,
        opacity: stroke.opacity,
        paintType: stroke.paintType,
        variation: stroke.variation,
        points: stroke.points.slice(sentPointCount.current),
      });
    }
    lastLiveSend.current = 0;
    sentPointCount.current = 0;

    return stroke;
  }, [canvasRef, drawLine, onStrokeLive, onMemeClick]);

  // Mouse event handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isReady) return;

    const handleMouseDown = (e) => {
      e.preventDefault();
      startPainting(e.clientX, e.clientY);
    };

    const handleMouseMove = (e) => {
      if (!isPainting.current) return;
      e.preventDefault();
      continuePainting(e.clientX, e.clientY);
    };

    const handleMouseUp = () => {
      const stroke = stopPainting();
      if (stroke && onStrokeComplete) {
        onStrokeComplete(stroke);
      }
    };

    const handleMouseLeave = () => {
      stopPainting();
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseLeave);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
    };
  }, [canvasRef, isReady, startPainting, continuePainting, stopPainting, lineStart, currentBrush]);

  // Touch event handlers
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !isReady) return;

    const handleTouchStart = (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      startPainting(touch.clientX, touch.clientY);
    };

    const handleTouchMove = (e) => {
      if (!isPainting.current) return;
      e.preventDefault();
      const touch = e.touches[0];
      continuePainting(touch.clientX, touch.clientY);
    };

    const handleTouchEnd = (e) => {
      e.preventDefault();
      const stroke = stopPainting();
      if (stroke && onStrokeComplete) {
        onStrokeComplete(stroke);
      }
    };

    const handleTouchCancel = () => {
      stopPainting();
    };

    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', handleTouchCancel, { passive: false });

    return () => {
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
      canvas.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [canvasRef, isReady, startPainting, continuePainting, stopPainting]);

  useEffect(() => {
    setIsEraser(currentBrush === BRUSH_TYPES.ERASER);
  }, [currentBrush]);

  // Stop any running drip animation when the hook unmounts.
  useEffect(() => clearDrips, [clearDrips]);

  return {
    isEraser,
    lineStart,
    isPainting: () => isPainting.current,
    startPainting,
    continuePainting,
    stopPainting,
    clearDrips,
  };
};
