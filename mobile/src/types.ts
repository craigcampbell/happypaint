export type BrushId = "marker" | "pencil" | "paint" | "spray" | "eraser" | "glow";

export type TextureId = "linen" | "canvas" | "smooth" | "night";

export type ToolMode = "gallery" | "studio" | "settings" | "together" | "discover";

export type DrawPoint = {
  x: number;
  y: number;
  size: number;
};

export type SprayDot = {
  x: number;
  y: number;
  radius: number;
};

export type Stroke = {
  id: string;
  brush: BrushId;
  color: string;
  opacity: number;
  size: number;
  variation: number;
  points: DrawPoint[];
  sprayDots?: SprayDot[];
};

export type DrawingProject = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  texture: TextureId;
  strokes: Stroke[];
  previewUri?: string;
  importedImageUri?: string;
};

export type BrushSettings = {
  brush: BrushId;
  color: string;
  size: number;
  opacity: number;
  variation: number;
  texture: TextureId;
};
