import { useState } from 'react';
import './ColorSelector.css';

const PRESET_COLORS = [
  '#1a1a2e', '#e94560', '#0f3460', '#16213e',
  '#533483', '#00b894', '#f39c12', '#27ae60',
  '#2980b9', '#8e44ad', '#c0392b', '#1abc9c',
  '#ffffff', '#bdc3c7', '#7f8c8d', '#2c3e50',
];

const ColorSelector = ({ onColorSelect, selectedColor }) => {
  const [showPicker, setShowPicker] = useState(false);
  const [customColor, setCustomColor] = useState(selectedColor || '#1a1a2e');

  const handleColorClick = (color) => {
    onColorSelect(color);
    setCustomColor(color);
    setShowPicker(false);
  };

  const handleCustomColorChange = (e) => {
    const color = e.target.value;
    setCustomColor(color);
    onColorSelect(color);
  };

  return (
    <div className="color-selector">
      <div className="color-grid">
        {PRESET_COLORS.map((color) => (
          <div
            key={color}
            className={`color-swatch ${selectedColor === color ? 'selected' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => handleColorClick(color)}
          />
        ))}
        <div
          className={`color-swatch custom-swatch ${showPicker ? 'active' : ''}`}
          style={{ backgroundColor: customColor }}
          onClick={() => setShowPicker(!showPicker)}
        >
          <span className="swatch-plus">+</span>
        </div>
      </div>

      {showPicker && (
        <div className="color-picker-container">
          <input
            type="color"
            value={customColor}
            onChange={handleCustomColorChange}
            className="color-input"
          />
          <input
            type="text"
            value={customColor}
            onChange={(e) => {
              setCustomColor(e.target.value);
              onColorSelect(e.target.value);
            }}
            className="hex-input"
            placeholder="#000000"
          />
        </div>
      )}
    </div>
  );
};

export default ColorSelector;
