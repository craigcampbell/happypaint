import { PAINT_TYPES, PAINT_PROPERTIES } from '../utils/paintTypes';
import PropTypes from 'prop-types';
import './Toolbar.css';

const PAINT_OPTIONS = [
  { value: PAINT_TYPES.NONE, label: '🎨 Standard' },
  { value: PAINT_TYPES.WATERCOLOR, label: '💧 Watercolor' },
  { value: PAINT_TYPES.ACRYLIC, label: '🖌️ Acrylic' },
  { value: PAINT_TYPES.OIL, label: '✨ Oil' },
];

const PaintTypeSelector = ({ currentPaintType, onPaintTypeChange }) => {
  return (
    <div className="brush-selector">
      <select
        value={currentPaintType}
        onChange={onPaintTypeChange}
        className="brush-select"
      >
        {PAINT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div className="paint-desc">
        {PAINT_PROPERTIES[currentPaintType]?.description || ''}
      </div>
    </div>
  );
};

PaintTypeSelector.propTypes = {
  currentPaintType: PropTypes.string.isRequired,
  onPaintTypeChange: PropTypes.func.isRequired,
};

export default PaintTypeSelector;
