import { useRef, useEffect, useState, useCallback } from 'react';
import { BRUSH_TYPES } from '../utils/constants';
import { PAINT_TYPES } from '../utils/paintTypes';

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
  onMemeClick
) => {
  const [isEraser, setIsEraser] = useState(false);
  const [lineStart, setLineStart] = useState(null);
  const isPainting = useRef(false);
  const lastPos = useRef(null);
  const currentStroke = useRef(null);

  const drawPoint = useCallback((ctx, x, y, brush, size, color, opacity, variation) => {
    ctx.globalAlpha = opacity;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
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
  }, []);

  function drawSpray(ctx, x, y, size, opacity, color, variation, airbrush) {
    const density = Math.floor(size * 2 * variation);
    ctx.globalAlpha = opacity * (airbrush ? 0.02 : 0.18);
    for (let i = 0; i < density; i++) {
      // Gaussian-like distribution for airbrush, uniform for spray
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

      // Vary opacity per particle for airbrush softness
      if (airbrush) {
        ctx.globalAlpha = opacity * 0.03 * (1 - radius / size);
      }

      ctx.beginPath();
      ctx.arc(dx, dy, particleSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawAirbrush(ctx, x, y, size, opacity, color, variation) {
    // Soft radial gradient base
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

    // Particulate spray for texture
    drawSpray(ctx, x, y, size * 0.6, opacity, color, variation, true);
  }

  function drawPaletteKnife(ctx, x, y, size, opacity, color) {
    // Flat rectangular smear shape
    const angle = lastPos.current
      ? Math.atan2(y - lastPos.current.y, x - lastPos.current.x)
      : 0;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    const w = size * 0.4;
    const h = size * 1.5;

    ctx.globalAlpha = opacity * 0.45;
    ctx.fillStyle = color;
    ctx.fillRect(-w, -h / 2, w * 2, h);

    // Scrape lines along the edge
    ctx.globalAlpha = opacity * 0.7;
    ctx.fillStyle = color;
    ctx.fillRect(-w * 1.2, -1, w * 2.4, 2);
    ctx.fillRect(-w * 1.2, -h / 2 + 2, w * 2.4, 1);

    ctx.restore();
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

    // Convert screen coordinates to virtual canvas coordinates
    // Camera frustum uses Math.max(w,h) / zoom → must match that scale
    const maxDim = Math.max(rect.width, rect.height);
    const scale = maxDim / (vp.zoom * rect.height);
    const x = vp.x + (relX - rect.width / 2) * scale;
    const y = vp.y + (relY - rect.height / 2) * scale;

    // Chat brush: create a chat thread at this position
    if (currentBrush === BRUSH_TYPES.CHAT) {
      if (onChatClick) onChatClick(x, y);
      return;
    }

    // Meme brush: open file picker
    if (currentBrush === BRUSH_TYPES.MEME) {
      if (onMemeClick) onMemeClick(x, y);
      return;
    }

    // Prevent painting when zoomed too far out

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

    if (onDrawStart) onDrawStart();

    currentStroke.current = {
      type: currentBrush === BRUSH_TYPES.ERASER ? BRUSH_TYPES.ERASER : currentBrush,
      paintType: currentBrush === BRUSH_TYPES.ERASER ? PAINT_TYPES.NONE : paintType,
      color: selectedColor,
      size: brushSize,
      opacity: brushOpacity,
      variation: brushVariation,
      points: [{ x, y }],
    };

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.save();
      drawPoint(ctx, x, y, currentBrush, brushSize, selectedColor, brushOpacity, brushVariation);
      ctx.restore();
    }
  }, [canvasRef, isReady, currentBrush, lineStart, brushSize, selectedColor, brushOpacity, brushVariation, paintType, drawPoint, drawLine]);

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
        // Palette knife smears existing paint then deposits new
        ctx.globalCompositeOperation = 'source-over';
        drawSmearStroke(ctx, lastPos.current.x, lastPos.current.y, x, y, brushSize, brushOpacity);

        // Then draw the knife stroke on top
        drawLine(
          ctx,
          lastPos.current.x, lastPos.current.y,
          x, y,
          currentBrush,
          brushSize,
          selectedColor,
          brushOpacity * 0.6,
          brushVariation
        );
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

    lastPos.current = { x, y };
  }, [canvasRef, isReady, currentBrush, brushSize, selectedColor, brushOpacity, brushVariation, drawLine]);

  function drawSmearStroke(ctx, x1, y1, x2, y2, size, opacity) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = Math.max(1, size / 3);
    const numSteps = Math.max(1, Math.floor(dist / step));

    // Sample and smudge
    for (let i = 0; i <= numSteps; i++) {
      const t = i / numSteps;
      const x = x1 + dx * t;
      const y = y1 + dy * t;

      // Pick up color from the canvas at this position
      const sampleSize = Math.floor(size * 0.3);
      const imgData = ctx.getImageData(
        Math.max(0, x - sampleSize),
        Math.max(0, y - sampleSize),
        Math.min(canvasRef.current.width - x + sampleSize, sampleSize * 2),
        Math.min(canvasRef.current.height - y + sampleSize, sampleSize * 2)
      );

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

      if (!ctx.fillStyle || ctx.fillStyle === '#000000') {
        ctx.fillStyle = 'rgba(128,128,128,0.1)';
      }
      ctx.globalAlpha = opacity * 0.15;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const stopPainting = useCallback(() => {
    isPainting.current = false;
    lastPos.current = null;

    const stroke = currentStroke.current;
    currentStroke.current = null;

    return stroke;
  }, []);

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
