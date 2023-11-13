import { useState, useRef, useEffect } from "react";
import "./App.css";

import linenTexture from "/linen.png";
import canvasTexture from "/canvas.png";

function App() {
  const canvasRef = useRef(null);
  const textureRef = useRef(null);
  const canvasTextures = [
    {
      name: "Linen",
      file: linenTexture, 
    },
    {
      name: "Canvas",
      file: canvasTexture, 
    },
  ];

  const [selectedTexture, setSelectedTexture] = useState(
    canvasTextures[0].file
  );

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
    let lastX;
let lastY;
const smoothingRatio = .09; // Adjust this value for more or less smoothing

const draw = (e) => {
  if (!painting) return;

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
  context.strokeStyle = "red";
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
  }, [selectedTexture]);

  const handleTextureChange = (event) => {
    setSelectedTexture(event.target.value);
  };

  return (
    <>
      <h1>Happy Paint</h1>
      <div>
        <label htmlFor="texture-selector">Choose a texture:</label>
        <select
          id="texture-selector"
          onChange={handleTextureChange}
          value={selectedTexture}
        >
          <br/>
          {canvasTextures.map((texture) => (
            <option key={texture.name} value={texture.file}>
              {texture.name}
            </option>
          ))}
        </select>
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
