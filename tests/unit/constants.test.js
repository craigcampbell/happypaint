import { describe, it, expect } from 'vitest';
import {
  BRUSH_TYPES,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  VIRTUAL_CANVAS_WIDTH,
  VIRTUAL_CANVAS_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_PER_SCROLL,
  PAINT_MIN_ZOOM,
  DEFAULT_BRUSH_SIZE,
  DEFAULT_SPRAY_BRUSH_SIZE,
  DEFAULT_BRUSH_VARIATION,
  DEFAULT_BRUSH_OPACITY,
  DRAWING_STEP_SIZE,
  ETCH_MOVE_SPEED,
  DEFAULT_TEXTURE,
  DEFAULT_COLOR,
  DEFAULT_BRUSH_TYPE,
  DEFAULT_PAINT_TYPE,
  INITIAL_ETCH_POSITION,
  TEXTURES,
} from '../../src/utils/constants';

describe('BRUSH_TYPES', () => {
  it('defines all basic brush types', () => {
    expect(BRUSH_TYPES.ROUND).toBe('round');
    expect(BRUSH_TYPES.SQUARE).toBe('square');
    expect(BRUSH_TYPES.SPRAY).toBe('spray');
    expect(BRUSH_TYPES.PENCIL).toBe('pencil');
    expect(BRUSH_TYPES.PEN).toBe('pen');
    expect(BRUSH_TYPES.LINE).toBe('line');
    expect(BRUSH_TYPES.ERASER).toBe('eraser');
    expect(BRUSH_TYPES.AIRBRUSH).toBe('airbrush');
  });

  it('defines advanced brush types', () => {
    expect(BRUSH_TYPES.PALETTE_KNIFE).toBe('paletteKnife');
    expect(BRUSH_TYPES.BLUR).toBe('blur');
    expect(BRUSH_TYPES.SMUDGE).toBe('smudge');
    expect(BRUSH_TYPES.WET_BRUSH).toBe('wetBrush');
    expect(BRUSH_TYPES.SPONGE).toBe('sponge');
    expect(BRUSH_TYPES.WET_PAINT).toBe('wetPaint');
  });

  it('defines interaction brush types', () => {
    expect(BRUSH_TYPES.CHAT).toBe('chat');
    expect(BRUSH_TYPES.MEME).toBe('meme');
  });

  it('all brush type values are unique', () => {
    const values = Object.values(BRUSH_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('Canvas dimensions', () => {
  it('defines display canvas size', () => {
    expect(CANVAS_WIDTH).toBe(800);
    expect(CANVAS_HEIGHT).toBe(600);
  });

  it('defines virtual canvas larger than display', () => {
    expect(VIRTUAL_CANVAS_WIDTH).toBeGreaterThan(CANVAS_WIDTH);
    expect(VIRTUAL_CANVAS_HEIGHT).toBeGreaterThan(CANVAS_HEIGHT);
  });

  it('virtual canvas dimensions are exact values', () => {
    expect(VIRTUAL_CANVAS_WIDTH).toBe(6000);
    expect(VIRTUAL_CANVAS_HEIGHT).toBe(4000);
  });
});

describe('Zoom configuration', () => {
  it('defines zoom range', () => {
    expect(MIN_ZOOM).toBeGreaterThan(0);
    expect(MAX_ZOOM).toBeGreaterThan(MIN_ZOOM);
  });

  it('paint min zoom is between min and max', () => {
    expect(PAINT_MIN_ZOOM).toBeGreaterThan(MIN_ZOOM);
    expect(PAINT_MIN_ZOOM).toBeLessThan(MAX_ZOOM);
  });

  it('zoom per scroll is positive', () => {
    expect(ZOOM_PER_SCROLL).toBeGreaterThan(0);
  });
});

describe('Default brush settings', () => {
  it('defines default brush size', () => {
    expect(DEFAULT_BRUSH_SIZE).toBeGreaterThan(0);
  });

  it('spray brush size is larger than default', () => {
    expect(DEFAULT_SPRAY_BRUSH_SIZE).toBeGreaterThan(DEFAULT_BRUSH_SIZE);
  });

  it('brush variation is between 0 and 1', () => {
    expect(DEFAULT_BRUSH_VARIATION).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_BRUSH_VARIATION).toBeLessThanOrEqual(1);
  });

  it('brush opacity is between 0 and 1', () => {
    expect(DEFAULT_BRUSH_OPACITY).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_BRUSH_OPACITY).toBeLessThanOrEqual(1);
  });
});

describe('Drawing behavior', () => {
  it('drawing step size is positive', () => {
    expect(DRAWING_STEP_SIZE).toBeGreaterThan(0);
  });

  it('etch move speed is positive', () => {
    expect(ETCH_MOVE_SPEED).toBeGreaterThan(0);
  });
});

describe('Default states', () => {
  it('default texture is valid', () => {
    expect(Object.values(TEXTURES)).toContain(DEFAULT_TEXTURE);
  });

  it('default color is a hex string', () => {
    expect(DEFAULT_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('default brush type is valid', () => {
    expect(Object.values(BRUSH_TYPES)).toContain(DEFAULT_BRUSH_TYPE);
  });

  it('initial etch position is a valid point', () => {
    expect(INITIAL_ETCH_POSITION).toHaveProperty('x');
    expect(INITIAL_ETCH_POSITION).toHaveProperty('y');
    expect(INITIAL_ETCH_POSITION.x).toBe(0);
    expect(INITIAL_ETCH_POSITION.y).toBe(0);
  });
});

describe('TEXTURES', () => {
  it('defines available textures', () => {
    expect(TEXTURES.LINEN).toBe('linen');
    expect(TEXTURES.CANVAS).toBe('canvas');
    expect(TEXTURES.NONE).toBe('none');
  });
});
