import './colorSelector.css';

function ColorSelector({ onColorSelect }) {
    const primaryColors = ['#ef4444', '#2563eb', '#facc15', '#22c55e', '#111827', '#ffffff'];

    return (
        <div className="color-selector">
            {primaryColors.map(color => (
                <button
                    type="button"
                    key={color}
                    className="color-circle"
                    style={{ backgroundColor: color }}
                    onClick={() => onColorSelect(color)}
                    aria-label={`Use ${color}`}
                />
            ))}
        </div>
    );
}

export default ColorSelector;
