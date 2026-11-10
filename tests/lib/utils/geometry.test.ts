import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { findElementGeometry, getElementPercentageGeometry } from '@/lib/utils/geometry';

const element = {
  id: 'box',
  type: 'shape',
  left: 640,
  top: 360,
  width: 128,
  height: 72,
  rotate: 0,
} as unknown as PPTElement;

describe('getElementPercentageGeometry', () => {
  it('keeps the 1000px 16:9 base by default', () => {
    const g = getElementPercentageGeometry(element)!;
    expect(g.x).toBeCloseTo(64);
    expect(g.y).toBeCloseTo(64);
  });

  it('uses the slide viewport size when given', () => {
    // A 1280px-wide slide: (640, 360) is the exact center.
    const g = getElementPercentageGeometry(element, 1280, 0.5625)!;
    expect(g.x).toBeCloseTo(50);
    expect(g.y).toBeCloseTo(50);
    expect(g.centerX).toBeCloseTo(55);
    expect(g.centerY).toBeCloseTo(55);
  });

  it('uses the slide viewport ratio when given', () => {
    // 4:3 slide, 1280 x 960.
    const g = getElementPercentageGeometry(element, 1280, 0.75)!;
    expect(g.y).toBeCloseTo(37.5);
    expect(g.h).toBeCloseTo(7.5);
  });
});

describe('findElementGeometry', () => {
  it('forwards the viewport size and ratio', () => {
    const scene = { type: 'slide', content: { canvas: { elements: [element] } } };
    expect(findElementGeometry(scene, 'box', 1280, 0.5625)?.centerX).toBeCloseTo(55);
    expect(findElementGeometry(scene, 'missing', 1280, 0.5625)).toBeNull();
  });
});
