import { PAINT_TYPES } from './paintTypes';

// Canvas configuration
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;

// Virtual canvas (the full painting surface)
export const VIRTUAL_CANVAS_WIDTH = 6000;
export const VIRTUAL_CANVAS_HEIGHT = 4000;
export const MURAL_BACKGROUND_COLOR = '#ffffff';

// Viewport / zoom
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 5.0;
export const ZOOM_PER_SCROLL = 0.08;
export const PAINT_MIN_ZOOM = 0.2; // below this zoom, painting is disabled

// Default brush settings
export const DEFAULT_BRUSH_SIZE = 8;
export const DEFAULT_SPRAY_BRUSH_SIZE = 35;
export const DEFAULT_BRUSH_VARIATION = 0.2;
export const DEFAULT_BRUSH_OPACITY = 1;

// Drawing behavior
export const DRAWING_STEP_SIZE = 1;
export const ETCH_MOVE_SPEED = 2;

// Default states
export const DEFAULT_TEXTURE = 'linen';
export const DEFAULT_COLOR = '#1a1a2e';
export const DEFAULT_BRUSH_TYPE = 'round';
export const DEFAULT_PAINT_TYPE = PAINT_TYPES.NONE;
export const INITIAL_ETCH_POSITION = { x: 0, y: 0 };

// Available textures
export const TEXTURES = {
  LINEN: 'linen',
  CANVAS: 'canvas',
  NONE: 'none',
};

// Brush types
export const BRUSH_TYPES = {
  ROUND: 'round',
  SQUARE: 'square',
  SPRAY: 'spray',
  PENCIL: 'pencil',
  PEN: 'pen',
  LINE: 'line',
  ERASER: 'eraser',
  AIRBRUSH: 'airbrush',
  PALETTE_KNIFE: 'paletteKnife',
  BLUR: 'blur',
  SMUDGE: 'smudge',
  WET_BRUSH: 'wetBrush',
  SPONGE: 'sponge',
  WET_PAINT: 'wetPaint',
  CHAT: 'chat',
  MEME: 'meme',
};
