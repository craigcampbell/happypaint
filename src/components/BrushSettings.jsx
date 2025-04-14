import React from 'react';

const BrushSettings = ({ 
  brushSize, 
  onBrushSizeChange, 
  brushVariation, 
  onBrushVariationChange 
}) => {
  return (
    <div className="brush-settings">
      <div>
        <label htmlFor="brush-size">Brush Size: {brushSize}px</label>
        <input
          type="range"
          id="brush-size"
          min="1"
          max="100"
          value={brushSize}
          onChange={(e) => onBrushSizeChange(Number(e.target.value))}
        />
      </div>
      <div>
        <label htmlFor="brush-variation">Size Variation: {brushVariation}%</label>
        <input
          type="range"
          id="brush-variation"
          min="0"
          max="100"
          value={brushVariation * 100}
          onChange={(e) => onBrushVariationChange(Number(e.target.value) / 100)}
        />
      </div>
    </div>
  );
};

export default BrushSettings; 