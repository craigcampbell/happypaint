import { useRef, useEffect, useState, useCallback } from 'react';
import { BRUSH_TYPES } from '../utils/constants';
import { PAINT_TYPES, PAINT_PROPERTIES } from '../utils/paintTypes';
import { mixPigments, hexToRgb, rgbToHex } from '../utils/colorMixer';

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
  const lastPos = useRef(null);
  const currentStroke = useRef(null);
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
    ctx.globalAlpha = opacity * (airbrush ? 0.02 : 0.18);
    for (let i = 0; i < density; i++) {
      let radius;
      if (airbrush) {
        const u = Math.random() + Math.random() + Math.random();
        radius = (u / 3) * size;
      } else {
        radius = Math.random() * size;
      }
      const angle = Math.random() * Math.PI * 2;
      const dx = x + radius * Math.cos(angle);
      const dy = y + radius * Math.sin(angle);
      const particleSize = airbrush
        ? Math.max(0.3, Math.random() * 1.0)
        : Math.max(0.5, Math.random() * 1.5);

      if (airbrush) {
        ctx.globalAlpha = opacity * 0.03 * (1 - radius / size);
      }

      ctx.beginPath();
      ctx.arc(dx, dy, particleSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawAirbrush(ctx, x, y, size, opacity, color, variation) {
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

  function drawPaletteKnife(ctx, x, y, size, opacity, color) {
    // Sample underlying color for realistic smearing
    const underlying = sampleUnderlyingColor(ctx, x, y, size * 0.5);

    const angle = lastPos.current
      ? Math.atan2(y - lastPos.current.y, x - lastPos.current.x)
      : Math.random() * Math.PI * 2;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    const w = size * 0.35;
    const h = size * 1.6;

    // Scrape effect: erase a thin line to reveal canvas
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = opacity * 0.25;
    ctx.fillRect(-w * 1.3, -0.5, w * 2.6, 1);
    ctx.fillRect(-w * 1.3, -h / 2 + 1.5, w * 2.6, 0.8);

    ctx.globalCompositeOperation = 'source-over';

    // Paint deposit: the knife leaves a smear of paint
    const smearColor = underlying && underlying !== '#ffffff'
      ? mixPigments(underlying, color, opacity * 0.5)
      : color;

    ctx.globalAlpha = opacity * 0.4;
    ctx.fillStyle = smearColor;
    ctx.fillRect(-w, -h / 2, w * 2, h);

    // Edge highlight (oil paint ridge)
    ctx.globalAlpha = opacity * 0.55;
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
      const data = imgData.data;

      // Box blur: average each pixel with its neighbors
      const kernel = Math.max(1, Math.floor(r * 0.35));
      const blurred = new Uint8ClampedArray(data.length);

      for (let py = 0; py < sh; py++) {
        for (let px = 0; px < sw; px++) {
          let sr = 0, sg = 0, sb = 0, sa = 0, count = 0;
          for (let ky = -kernel; ky <= kernel; ky++) {
            for (let kx = -kernel; kx <= kernel; kx++) {
              const nx = px + kx;
              const ny = py + ky;
              if (nx >= 0 && nx < sw && ny >= 0 && ny < sh) {
                const idx = (ny * sw + nx) * 4;
                const weight = 1 - (Math.abs(kx) + Math.abs(ky)) / (kernel * 2 + 1);
                sr += data[idx] * weight;
                sg += data[idx + 1] * weight;
                sb += data[idx + 2] * weight;
                sa += data[idx + 3] * weight;
                count += weight;
              }
            }
          }
          const outIdx = (py * sw + px) * 4;
          blurred[outIdx] = Math.round(sr / count);
          blurred[outIdx + 1] = Math.round(sg / count);
          blurred[outIdx + 2] = Math.round(sb / count);
          blurred[outIdx + 3] = Math.round(sa / count);
        }
      }

      ctx.putImageData(new ImageData(blurred, sw, sh), sx, sy);
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
    const step = Math.max(1, size / 4);
    const numSteps = Math.max(1, Math.floor(distance / step));

    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;
      drawPoint(ctx, x, y, brush, size, color, opacity, variation);
    }
  }, [drawPoint]);

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
      if (onMemeClick) onMemeClick(x, y);
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
          drawLine(ctx, lineStart.x, lineStart.y, x, y, BRUSH_TYPES.ROUND, brushSize, selectedColor, brushOpacity, brushVariation);
        }
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
  }, [canvasRef, isReady, currentBrush, lineStart, brushSize, selectedColor, brushOpacity, brushVariation, paintType, drawPoint, drawLine, onChatClick, onMemeClick, viewportRef]);

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

    if (!lastPos.current) {
      lastPos.current = { x, y };
      return;
    }

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();

      if (currentBrush === BRUSH_TYPES.PALETTE_KNIFE) {
        // Palette knife: smear existing paint then deposit new
        ctx.globalCompositeOperation = 'source-over';
        drawSmearStroke(ctx, lastPos.current.x, lastPos.current.y, x, y, brushSize, brushOpacity);

        // Draw knife stroke on top
        drawLine(
          ctx,
          lastPos.current.x, lastPos.current.y,
          x, y,
          currentBrush,
          brushSize,
          selectedColor,
          brushOpacity * 0.5,
          brushVariation
        );
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
  }, [canvasRef, isReady, currentBrush, brushSize, selectedColor, brushOpacity, brushVariation, drawLine, onStrokeLive]);

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
    isPainting.current = false;

    const stroke = currentStroke.current;
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
  }, [onStrokeLive]);

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
      if (lineStart && currentBrush === BRUSH_TYPES.LINE) {
        setLineStart(null);
      }
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

  return {
    isEraser,
    lineStart,
    isPainting: () => isPainting.current,
    startPainting,
    continuePainting,
    stopPainting,
  };
};
