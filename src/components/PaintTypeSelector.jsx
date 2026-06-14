import { PAINT_TYPES, PAINT_PROPERTIES } from '../utils/paintTypes';
import PropTypes from 'prop-types';
import './Toolbar.css';

const PAINT_OPTIONS = [
  { value: PAINT_TYPES.NONE, icon: '🎨', label: 'Standard' },
  { value: PAINT_TYPES.WATERCOLOR, icon: '💧', label: 'Watercolor' },
  { value: PAINT_TYPES.ACRYLIC, icon: '🖌️', label: 'Acrylic' },
  { value: PAINT_TYPES.OIL, icon: '✨', label: 'Oil' },
];

const PaintTypeSelector = ({ currentPaintType, onPaintTypeChange }) => {
  return (
    <div className="brush-selector">
      <div className="paint-pills" role="radiogroup" aria-label="Paint type">
        {PAINT_OPTIONS.map((opt) => {
          const active = currentPaintType === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              className={`paint-pill ${active ? 'active' : ''}`}
              onClick={() => onPaintTypeChange(opt.value)}
            >
              <span aria-hidden="true">{opt.icon}</span>
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

PaintTypeSelector.propTypes = {
  currentPaintType: PropTypes.string.isRequired,
  onPaintTypeChange: PropTypes.func.isRequired,
};

export default PaintTypeSelector;
