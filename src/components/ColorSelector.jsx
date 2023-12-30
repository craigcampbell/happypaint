import React from 'react';
import PropTypes from 'prop-types'; // Import PropTypes
import './colorSelector.css';

function ColorSelector({ onColorSelect }) {
    const primaryColors = ['red', 'blue', 'yellow', 'green', 'black', 'white'];

    return (
        <div className="color-selector">
            {primaryColors.map(color => (
                <div 
                    key={color}
                    className="color-circle"
                    style={{ backgroundColor: color }}
                    onClick={() => onColorSelect(color)}
                />
            ))}
        </div>
    );
}

// Define prop types
ColorSelector.propTypes = {
    onColorSelect: PropTypes.func.isRequired,
};

export default ColorSelector;
