import { describe, it, expect } from 'vitest';
import { PAINT_TYPES, PAINT_PROPERTIES } from '../../src/utils/paintTypes';

describe('PAINT_TYPES', () => {
  it('defines all paint types', () => {
    expect(PAINT_TYPES.NONE).toBe('none');
    expect(PAINT_TYPES.WATERCOLOR).toBe('watercolor');
    expect(PAINT_TYPES.ACRYLIC).toBe('acrylic');
    expect(PAINT_TYPES.OIL).toBe('oil');
  });

  it('has unique values', () => {
    const values = Object.values(PAINT_TYPES);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('PAINT_PROPERTIES', () => {
  it('has properties for every paint type', () => {
    for (const type of Object.values(PAINT_TYPES)) {
      expect(PAINT_PROPERTIES[type]).toBeDefined();
    }
  });

  it('each paint type has required fields', () => {
    const requiredFields = [
      'label',
      'description',
      'wetness',
      'spread',
      'impasto',
      'glossiness',
      'edgeDarkening',
      'granulation',
      'blendFactor',
      'dryingTime',
      'opacityRange',
      'defaultOpacity',
    ];

    for (const type of Object.values(PAINT_TYPES)) {
      const props = PAINT_PROPERTIES[type];
      for (const field of requiredFields) {
        expect(props).toHaveProperty(field);
      }
    }
  });

  it('all numeric property values are in valid ranges', () => {
    const numericProps = ['wetness', 'spread', 'impasto', 'glossiness', 'granulation', 'blendFactor', 'defaultOpacity'];

    for (const type of Object.values(PAINT_TYPES)) {
      const props = PAINT_PROPERTIES[type];
      for (const prop of numericProps) {
        expect(props[prop]).toBeGreaterThanOrEqual(0);
        expect(props[prop]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('opacityRange is a valid 2-element array', () => {
    for (const type of Object.values(PAINT_TYPES)) {
      const props = PAINT_PROPERTIES[type];
      expect(Array.isArray(props.opacityRange)).toBe(true);
      expect(props.opacityRange).toHaveLength(2);
      expect(props.opacityRange[0]).toBeLessThanOrEqual(props.opacityRange[1]);
    }
  });

  it('defaultOpacity is within opacityRange', () => {
    for (const type of Object.values(PAINT_TYPES)) {
      const props = PAINT_PROPERTIES[type];
      expect(props.defaultOpacity).toBeGreaterThanOrEqual(props.opacityRange[0]);
      expect(props.defaultOpacity).toBeLessThanOrEqual(props.opacityRange[1]);
    }
  });

  it('none type has zero impasto', () => {
    expect(PAINT_PROPERTIES[PAINT_TYPES.NONE].impasto).toBe(0);
  });

  it('oil has highest impasto', () => {
    const oilImpasto = PAINT_PROPERTIES[PAINT_TYPES.OIL].impasto;
    const watercolorImpasto = PAINT_PROPERTIES[PAINT_TYPES.WATERCOLOR].impasto;
    const acrylicImpasto = PAINT_PROPERTIES[PAINT_TYPES.ACRYLIC].impasto;
    expect(oilImpasto).toBeGreaterThan(watercolorImpasto);
    expect(oilImpasto).toBeGreaterThan(acrylicImpasto);
  });

  it('watercolor has edgeDarkening enabled', () => {
    expect(PAINT_PROPERTIES[PAINT_TYPES.WATERCOLOR].edgeDarkening).toBe(true);
  });

  it('watercolor has highest wetness', () => {
    const wcWetness = PAINT_PROPERTIES[PAINT_TYPES.WATERCOLOR].wetness;
    for (const type of Object.values(PAINT_TYPES)) {
      if (type !== PAINT_TYPES.WATERCOLOR) {
        expect(wcWetness).toBeGreaterThanOrEqual(PAINT_PROPERTIES[type].wetness);
      }
    }
  });

  it('each paint type has a non-empty label and description', () => {
    for (const type of Object.values(PAINT_TYPES)) {
      const props = PAINT_PROPERTIES[type];
      expect(props.label).toBeTruthy();
      expect(typeof props.label).toBe('string');
      expect(props.description).toBeTruthy();
      expect(typeof props.description).toBe('string');
    }
  });
});
