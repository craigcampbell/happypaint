import React from 'react';
import './Toolbar.css';

const BrushSelector = ({ currentBrush, onBrushChange, options }) => {
  return (
    <div className="brush-selector">
      <select
        value={currentBrush}
        onChange={onBrushChange}
        className="brush-select"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
};

export default BrushSelector;
