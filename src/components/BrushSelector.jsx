import { brushCatalog } from "../utils/brushes";

const BrushSelector = ({ currentBrush, onBrushChange }) => {
  return (
    <div>
      <label htmlFor="brush-selector">Choose a brush type:</label>
      <select id="brush-selector" value={currentBrush} onChange={onBrushChange}>
        {brushCatalog.map((brush) => (
          <option key={brush.id} value={brush.id}>
            {brush.name}
          </option>
        ))}
      </select>
    </div>
  );
};

export default BrushSelector;
