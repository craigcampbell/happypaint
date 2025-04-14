import React from 'react';

const brushes = {
  round: {
    draw: (ctx, x, y, size, selectedColor, opacity) => {
      ctx.globalAlpha = opacity;
      ctx.fillStyle = selectedColor;
      ctx.beginPath();
      ctx.arc(x, y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    },
  },
  square: {
    draw: (ctx, x, y, size, selectedColor, opacity) => {
      ctx.globalAlpha = opacity;
      ctx.fillStyle = selectedColor;
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
    },
  },
  spray: {
    draw: (ctx, x, y, size, selectedColor, opacity) => {
      ctx.globalAlpha = opacity;
      for (let i = 0; i < size * 10; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * size;
        const offsetX = x + radius * Math.cos(angle);
        const offsetY = y + radius * Math.sin(angle);
        const randomSize = Math.random() * 2;
        
        ctx.fillStyle = selectedColor;
        ctx.beginPath();
        ctx.arc(offsetX, offsetY, randomSize, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  line: {
    draw: (ctx, x, y, size, selectedColor, opacity) => {
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = selectedColor;
      if (this.lastX === undefined || this.lastY === undefined) {
        this.lastX = x;
        this.lastY = y;
      }
      ctx.beginPath();
      ctx.moveTo(this.lastX, this.lastY);
      ctx.lineTo(x, y);
      ctx.lineWidth = size;
      ctx.stroke();
      this.lastX = x;
      this.lastY = y;
    },
    reset: () => {
      this.lastX = undefined;
      this.lastY = undefined;
    }
  },
};

const BrushSelector = ({ currentBrush, onBrushChange }) => {
  return (
    <div>
      <label htmlFor="brush-selector">Choose a brush type:</label>
      <select id="brush-selector" value={currentBrush} onChange={onBrushChange}>
        <option value="round">Round</option>
        <option value="square">Square</option>
        <option value="spray">Spray</option>
        <option value="line">Line</option>
      </select>
    </div>
  );
};

// Export both the component and the brushes object
export { BrushSelector as default, brushes };