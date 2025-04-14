import { useState, useRef, useEffect } from "react";
import "./App.css";
import TextureSelector from './components/TextureSelector';
import ColorSelector from './components/ColorSelector';
import BrushSelector, { brushes } from './components/BrushSelector';
import BrushSettings from './components/BrushSettings';

function App() {
  const canvasRef = useRef(null);
  const textureRef = useRef(null);

  const [selectedTexture, setSelectedTexture] = useState("/linen.png");
  const [selectedColor, setSelectedColor] = useState('black');
  const [currentBrush, setCurrentBrush] = useState('round');
  const [brushSize, setBrushSize] = useState(8);
  const [brushVariation, setBrushVariation] = useState(0.2);
  const [brushOpacity, setBrushOpacity] = useState(0.9);

  const handleColorSelect = (color) => {
    setSelectedColor(color);
  };

  const handleBrushChange = (event) => {
    setCurrentBrush(event.target.value);
  };

  const handleBrushSizeChange = (size) => {
    setBrushSize(size);
  };

  const handleBrushVariationChange = (variation) => {
    setBrushVariation(variation);
  };

  let lastX, lastY; 
  
  useEffect(() => {
    const canvas = canvasRef.current;
    const texture = textureRef.current;
    const context = canvas.getContext("2d");
    const img = new Image();
    const textureCtx = texture.getContext("2d");
    img.src = selectedTexture;
    img.onload = () => {
      // Save the current state of the drawing
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  
      // Clear the texture canvas and apply the new texture
      textureCtx.clearRect(0, 0, texture.width, texture.height);
      textureCtx.drawImage(img, 0, 0, texture.width, texture.height);
  
      // Restore the drawing
      context.putImageData(imageData, 0, 0);
    };
    let painting = false;
    const startPosition = (e) => {
      painting = true;
      draw(e);
    };
    const finishedPosition = () => {
      painting = false;
      context.beginPath();
    };
let smoothingRatio = 0.0;
if (brushes[currentBrush] != brushes.line) {
  smoothingRatio = 1.0;
}
smoothingRatio = .09;
 // Adjust this value for more or less smoothing

const draw = (e) => {
  if (!painting) return;
  
  const rect = canvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  if (lastX === undefined || lastY === undefined) {
    lastX = currentX;
    lastY = currentY;
    return;
  }

  const dx = currentX - lastX;
  const dy = currentY - lastY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const stepSize = 1;
  const numSteps = Math.max(Math.floor(distance / stepSize), 1);

  for (let i = 0; i < numSteps; i++) {
    const t = i / numSteps;
    const x = lastX + dx * t;
    const y = lastY + dy * t;
    
    const variation = 1 + (Math.random() * 2 - 1) * brushVariation;
    const currentBrushSize = brushSize * variation;
    
    const brush = brushes[currentBrush];
    brush.draw(context, x, y, currentBrushSize, selectedColor, brushOpacity);
  }

  lastX = currentX;
  lastY = currentY;
};

canvas.addEventListener('mousedown', (e) => {
  painting = true;
  lastX = undefined;
  lastY = undefined;
  draw(e);
});
canvas.addEventListener('mouseup', () => {
  painting = false;
});
canvas.addEventListener('mousemove', draw);

    // Clean up
    return () => {
      canvas.removeEventListener("mousedown", startPosition);
      canvas.removeEventListener("mouseup", finishedPosition);
      canvas.removeEventListener("mousemove", draw);
    };
  }, [selectedTexture, selectedColor, currentBrush]);

  const handleTextureChange = (event) => {
    setSelectedTexture(event.target.value);
  };

  return (
    <>
     <h1>Happy Paint</h1>
      <div>
        <label htmlFor="texture-selector">Choose a texture:</label>
        <TextureSelector
          selectedTexture={selectedTexture}
          onTextureChange={handleTextureChange}
        />
        <ColorSelector onColorSelect={handleColorSelect} />
        <BrushSelector 
          currentBrush={currentBrush}
          onBrushChange={handleBrushChange}
        />
        <BrushSettings
          brushSize={brushSize}
          onBrushSizeChange={handleBrushSizeChange}
          brushVariation={brushVariation}
          onBrushVariationChange={handleBrushVariationChange}
        />
      </div>
      <div className="canvas-container">
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        style={{ border: "1px solid black", zIndex: 2, position: "absolute"}}
      ></canvas>
      <canvas
        ref={textureRef}
        width={800}
        height={600}
        style={{ border: "1px solid black", zIndex: 1, position: "absolute"}}
      ></canvas>
      </div>
    </>
  );
}

export default App;
