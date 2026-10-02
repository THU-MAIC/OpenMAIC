import { describe, expect, it } from 'vitest';
import type { PPTLineElement } from '@openmaic/dsl';
import { getElementRange, getLineElementPath } from '../../src/utils/element';

const line = (overrides: Partial<PPTLineElement> = {}): PPTLineElement => ({
  id: 'line',
  type: 'line',
  left: 100,
  top: 100,
  width: 2,
  start: [0, 0],
  end: [40, 0],
  style: 'solid',
  color: '#000000',
  points: ['', ''],
  ...overrides,
});

describe('line bounds', () => {
  it.each<{
    name: string;
    element: Partial<PPTLineElement>;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  }>([
    {
      name: 'plain line',
      element: { end: [50, 30] },
      bounds: { minX: 100, maxX: 150, minY: 100, maxY: 130 },
    },
    {
      name: 'endpoints away from the origin',
      element: { start: [10, 5], end: [40, 25] },
      bounds: { minX: 110, maxX: 140, minY: 105, maxY: 125 },
    },
    {
      name: 'reversed endpoints with negative offsets',
      element: { start: [40, 25], end: [-10, -5] },
      bounds: { minX: 90, maxX: 140, minY: 95, maxY: 125 },
    },
    {
      name: 'quadratic control hull',
      element: { curve: [20, 60] },
      bounds: { minX: 100, maxX: 140, minY: 100, maxY: 160 },
    },
    {
      name: 'single elbow outside the endpoints',
      element: { broken: [80, -20] },
      bounds: { minX: 100, maxX: 180, minY: 80, maxY: 100 },
    },
    {
      name: 'both cubic control points',
      element: {
        cubic: [
          [-10, 20],
          [50, -30],
        ],
      },
      bounds: { minX: 90, maxX: 150, minY: 70, maxY: 120 },
    },
    {
      name: 'only the active path variant',
      element: { broken: [20, 10], curve: [500, 500] },
      bounds: { minX: 100, maxX: 140, minY: 100, maxY: 110 },
    },
  ])('contains $name', ({ element, bounds }) => {
    expect(getElementRange(line(element))).toEqual(bounds);
  });
});

describe('double elbows', () => {
  it.each<{
    name: string;
    element: Partial<PPTLineElement>;
    path: string;
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  }>([
    {
      name: 'horizontal ignores the unused y coordinate',
      element: { end: [100, 20], broken2: [50, 500] },
      path: 'M0,0 L50,0 L50,20 100,20',
      bounds: { minX: 100, maxX: 200, minY: 100, maxY: 120 },
    },
    {
      name: 'vertical ignores the unused x coordinate',
      element: { end: [20, 100], broken2: [500, 50] },
      path: 'M0,0 L0,50 L20,50 20,100',
      bounds: { minX: 100, maxX: 120, minY: 100, maxY: 200 },
    },
    {
      name: 'horizontal includes an outlying x coordinate',
      element: { end: [100, 20], broken2: [-50, 500] },
      path: 'M0,0 L-50,0 L-50,20 100,20',
      bounds: { minX: 50, maxX: 200, minY: 100, maxY: 120 },
    },
    {
      name: 'vertical includes an outlying y coordinate',
      element: { end: [20, 100], broken2: [500, -50] },
      path: 'M0,0 L0,-50 L20,-50 20,100',
      bounds: { minX: 100, maxX: 120, minY: 50, maxY: 200 },
    },
    {
      name: 'nonzero endpoints preserve the existing horizontal route',
      element: { start: [100, 0], end: [120, 80], broken2: [110, 500] },
      path: 'M100,0 L110,0 L110,80 120,80',
      bounds: { minX: 200, maxX: 220, minY: 100, maxY: 180 },
    },
    {
      name: 'equal endpoint extents preserve the horizontal route',
      element: { end: [40, 40], broken2: [60, 500] },
      path: 'M0,0 L60,0 L60,40 40,40',
      bounds: { minX: 100, maxX: 160, minY: 100, maxY: 140 },
    },
  ])('$name', ({ element, path, bounds }) => {
    expect(getLineElementPath(line(element))).toBe(path);
    expect(getElementRange(line(element))).toEqual(bounds);
  });
});
