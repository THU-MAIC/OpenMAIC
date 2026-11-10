// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PPTTextElement, Slide } from '../../dsl/src';
import type { PercentageGeometry } from '../src/utils/geometry';
import { SlideCanvas } from '../src/SlideCanvas';

const laserGeometries: PercentageGeometry[] = [];

vi.mock('../src/effects/LaserOverlay', () => ({
  LaserOverlay: ({ geometry }: { geometry: PercentageGeometry }) => {
    laserGeometries.push(geometry);
    return <div data-testid="laser" />;
  },
}));

// A 1280 x 720 slide whose only element is centered at (640, 360).
const element: PPTTextElement = {
  id: 'box',
  type: 'text',
  left: 576,
  top: 312,
  width: 128,
  height: 96,
  rotate: 0,
  content: '<p>Hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
};

const slide: Slide = {
  id: 'slide-1',
  viewportSize: 1280,
  viewportRatio: 0.5625,
  elements: [element],
  theme: {
    fontName: 'Arial',
    fontColor: '#111111',
    backgroundColor: '#ffffff',
    themeColors: ['#111111'],
  },
  background: { type: 'solid', color: '#ffffff' },
};

describe('SlideCanvas laser', () => {
  it('positions the laser in full-frame percentages, without an inset', () => {
    laserGeometries.length = 0;
    const { getByTestId } = render(
      <SlideCanvas
        slide={slide}
        scale={1}
        chrome={false}
        effects={{ laser: { elementId: 'box', color: '#ff0000' } }}
      />,
    );

    expect(laserGeometries.at(-1)?.centerX).toBeCloseTo(50);
    expect(laserGeometries.at(-1)?.centerY).toBeCloseTo(50);

    // The layer the percentages resolve against must cover the whole frame.
    const layer = getByTestId('laser').parentElement!;
    expect(layer.style.inset).toBe('0px');
    expect(layer.style.padding).toBe('');
  });
});
