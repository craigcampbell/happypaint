import { useRef, useEffect, useState } from 'react';
import { CANVAS_WIDTH, CANVAS_HEIGHT } from '../utils/constants';

export const useCanvas = (selectedTexture, dimensions) => {
  const canvasRef = useRef(null);
  const textureCanvasRef = useRef(null);
  const [isReady, setIsReady] = useState(true);

  // Initialize main canvas with white background
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      setIsReady(false);
      return;
    }

    // Fill with white
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    setIsReady(true);
  }, [dimensions]);

  // Load texture onto texture canvas
  useEffect(() => {
    const texture = textureCanvasRef.current;
    if (!texture) return;

    const textureCtx = texture.getContext('2d');
    if (!textureCtx) return;

    if (selectedTexture === 'none') {
      textureCtx.clearRect(0, 0, texture.width, texture.height);
      return;
    }

    // Load texture image
    const img = new Image();
    let loaded = false;

    img.onload = () => {
      textureCtx.clearRect(0, 0, texture.width, texture.height);
      textureCtx.fillStyle = '#ffffff';
      textureCtx.fillRect(0, 0, texture.width, texture.height);
      textureCtx.drawImage(img, 0, 0, texture.width, texture.height);
      loaded = true;
    };

    img.onerror = () => {
      // Fallback: create a subtle noise texture
      textureCtx.fillStyle = '#ffffff';
      textureCtx.fillRect(0, 0, texture.width, texture.height);
      createNoiseTexture(textureCtx, texture.width, texture.height);
      loaded = true;
    };

    // Use inline textures instead of external files
    if (selectedTexture === 'linen') {
      img.src = createLinenTexture();
    } else if (selectedTexture === 'canvas') {
      img.src = createCanvasTexture();
    }
  }, [selectedTexture, dimensions]);

  return {
    canvasRef,
    textureCanvasRef,
    isReady,
    textureCanvas: textureCanvasRef.current,
  };
};

function createNoiseTexture(ctx, width, height) {
  const imageData = ctx.createImageData(width, height);
  for (let i = 0; i < imageData.data.length; i += 4) {
    const noise = Math.random() * 30;
    imageData.data[i] = 255 - noise;
    imageData.data[i + 1] = 255 - noise;
    imageData.data[i + 2] = 255 - noise;
    imageData.data[i + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

function createLinenTexture() {
  const size = 200;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#f5f0e8';
  ctx.fillRect(0, 0, size, size);

  // Draw linen-like weave pattern
  ctx.strokeStyle = 'rgba(180, 170, 155, 0.3)';
  ctx.lineWidth = 0.5;

  for (let i = 0; i < size; i += 3) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }

  return canvas.toDataURL();
}

function createCanvasTexture() {
  const size = 200;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#faf8f3';
  ctx.fillRect(0, 0, size, size);

  // Canvas weave pattern
  ctx.fillStyle = 'rgba(200, 195, 185, 0.2)';
  for (let y = 0; y < size; y += 4) {
    for (let x = 0; x < size; x += 4) {
      if ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0) {
        ctx.fillRect(x, y, 4, 4);
      }
    }
  }

  return canvas.toDataURL();
}
