import React from 'react';
import './Toolbar.css';

// Tactile, tappable brush bar. Each brush is a chip with a big emoji + short name.
const BrushSelector = ({ currentBrush, onBrushChange, options }) => {
  return (
    <div className="brush-selector">
      <div className="brush-bar" role="radiogroup" aria-label="Brush">
        {options.map((opt) => {
          const active = currentBrush === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              title={opt.name || opt.label}
              className={`brush-chip ${active ? 'active' : ''}`}
              onClick={() => onBrushChange(opt.value)}
            >
              <span className="brush-chip-icon" aria-hidden="true">{opt.icon}</span>
              <span className="brush-chip-name">{opt.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default BrushSelector;
