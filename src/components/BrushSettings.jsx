import React from 'react';

const BrushSettings = ({ 
  brushSize, 
  onBrushSizeChange, 
  brushVariation, 
  onBrushVariationChange,
  currentBrush 
}) => {
  const handleSizeChange = (e) => {
    const newSize = parseInt(e.target.value, 10);
    onBrushSizeChange(newSize);
  };

  return (
    <div className="brush-settings">
      <div>
        <label htmlFor="brush-size">
          {currentBrush === 'spray' ? 'Spray Radius' : 'Brush Size'}: {brushSize}px
        </label>
        <input
          type="range"
          id="brush-size"
          min={currentBrush === 'spray' ? '5' : '1'}
          max={currentBrush === 'spray' ? '50' : '100'}
          value={brushSize}
          onChange={handleSizeChange}
        />
      </div>
      {currentBrush === 'spray' && (
        <div>
          <label htmlFor="brush-variation">
            Spray Density: {Math.round(brushVariation * 100)}%
          </label>
          <input
            type="range"
            id="brush-variation"
            min="0"
            max="100"
            value={(brushVariation * 100)*2}
            onChange={(e) => onBrushVariationChange(Number(e.target.value) / 100)}
          />
        </div>
      )}
    </div>
  );
};

export default BrushSettings; 
