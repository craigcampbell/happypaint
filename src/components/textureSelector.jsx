import React from 'react';
import linenTexture from "/linen.png";
import canvasTexture from "/canvas.png";

function TextureSelector({ selectedTexture, onTextureChange }) {
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

  return (
    <div>
      <label htmlFor="texture-selector">Choose a texture:</label>
      <select
        id="texture-selector"
        onChange={onTextureChange}
        value={selectedTexture}
      >
        {canvasTextures.map((texture) => (
          <option key={texture.name} value={texture.file}>
            {texture.name}
            </option>
          ))}
      </select>
    </div>
  );
}

export default TextureSelector;
