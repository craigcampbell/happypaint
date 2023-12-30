import { useState, useRef, useEffect } from "react";
import "./App.css";
import TextureSelector from './components/TextureSelector';
import ColorSelector from './components/ColorSelector';

function App() {
  const canvasRef = useRef(null);
  const textureRef = useRef(null);

  const [selectedTexture, setSelectedTexture] = useState("/linen.png");
  const [selectedColor, setSelectedColor] = useState('black'); 
  const [currentBrush, setCurrentBrush] = useState('round');
  const [brushSize, setBrushSize] = useState(8);  // Example brush size
  const [brushOpacity, setBrushOpacity] = useState(0.9);  // Exa

  const handleColorSelect = (color) => {
    setSelectedColor(color);
  };
  
  
  
  const brushes = {
    round: {
      draw: (ctx, x, y, size, opacity) => {
        ctx.globalAlpha = opacity;
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      },
    },
    square: {
      draw: (ctx, x, y, size, opacity) => {
        ctx.globalAlpha = opacity;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      },
    },
    spray: {
      draw: (ctx, x, y, size, baseOpacity, selectedColor) => {
        for (let i = 0; i < size * 10; i++) {
          // Random angle and distance for the circular spray effect
          const angle = Math.random() * Math.PI * 2;
          const radius = Math.random() * size;
    
          // Offset x and y coordinates
          const offsetX = x + radius * Math.cos(angle);
          const offsetY = y + radius * Math.sin(angle);
    
          // Randomize size and opacity for each dot
          const randomSize = Math.random() * 2; // Size range of 0 to 2
          const randomOpacity = Math.random() * baseOpacity; // Opacity up to the base opacity
    
          // Convert color to RGBA and apply random opacity
          const colorWithOpacity = `rgba(${selectedColor.r}, ${selectedColor.g}, ${selectedColor.b}, ${randomOpacity})`;
          
          ctx.fillStyle = colorWithOpacity;
          ctx.beginPath();
          ctx.arc(offsetX, offsetY, randomSize, 0, Math.PI * 2);
          ctx.fill();
        }
      },
    },
    
    line: {
      draw: (ctx, x, y, size, opacity) => {
        ctx.globalAlpha = opacity;
        if (this.lastX === undefined || this.lastY === undefined) {
          this.lastX = x;
          this.lastY = y;
        }
        ctx.beginPath();
        ctx.moveTo(this.lastX, this.lastY);
        ctx.lineTo(x, y);
        ctx.lineWidth = size;
        ctx.stroke();
        this.lastX = x;
        this.lastY = y;
      },
      reset: () => {
        this.lastX = undefined;
        this.lastY = undefined;
      }
    },
    // Add more brushes as needed
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
    setCurrentBrush('square');
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
  context.strokeStyle = selectedColor;
  const brush = brushes[currentBrush]; // currentBrush is the selected brush type
  brush.draw(context, lastX, lastY, 50, 0.2); // Use the selected brush
  const rect = canvas.getBoundingClientRect();
  const currentX = e.clientX - rect.left;
  const currentY = e.clientY - rect.top;

  if (lastX === undefined || lastY === undefined) {
    lastX = currentX;
    lastY = currentY;
  }

  const smoothedX = lastX + (currentX - lastX) * smoothingRatio;
  const smoothedY = lastY + (currentY - lastY) * smoothingRatio;

  context.lineWidth = 5;
  context.strokeStyle = selectedColor;
  context.lineCap = "round";
  context.lineJoin = "round";

  context.beginPath();
  context.moveTo(lastX, lastY);
  context.lineTo(smoothedX, smoothedY);
  context.stroke();

  lastX = smoothedX;
  lastY = smoothedY;
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
