import type { PPTShapeElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';
import {
  areBasicShapes,
  isCircle,
  isPentagon,
  isRightTriangle,
  squareOnHypotenuse,
} from '@/eval/whiteboard-shapes/geometry-checks';

function shape(overrides: Partial<PPTShapeElement> = {}): PPTShapeElement {
  return {
    id: 'eval-shape',
    type: 'shape',
    path: 'M0 0 H1 V1 H0 Z',
    viewBox: [1, 1],
    left: 80,
    top: 100,
    width: 120,
    height: 120,
    rotate: 0,
    fill: '#5b9bd5',
    fixedRatio: false,
    ...overrides,
  };
}

const triangle = shape({
  path: 'M0 0 L4 0 L0 3 Z',
  viewBox: [4, 3],
  left: 100,
  width: 240,
  height: 180,
});
const hypotenuseSquare = shape({
  left: 160,
  top: 160,
  width: 300,
  height: 300,
  rotate: -36.86989765,
});
const pentagon = shape({
  path: 'M0 0 L4 0 L4 2 L2 3 L0 2 Z',
  viewBox: [4, 3],
  width: 240,
  height: 180,
});
const circle = shape({
  path: 'M1 0 A1 1 0 1 1 1 2 A1 1 0 1 1 1 0 Z',
  viewBox: [2, 2],
  left: 340,
});

describe('whiteboard shape evaluation geometry', () => {
  it('scores the actual triangle after applying element rotation', () => {
    expect(isRightTriangle(triangle)).toBe(true);
    expect(isRightTriangle({ ...triangle, rotate: 90 })).toBe(false);
    expect(isRightTriangle({ ...triangle, path: 'M0 0 H4 V3 H0 Z' })).toBe(false);
  });

  it('accepts the actual outward hypotenuse square in either winding direction', () => {
    expect(squareOnHypotenuse(hypotenuseSquare)).toBe(true);
    expect(squareOnHypotenuse({ ...hypotenuseSquare, path: 'M0 0 V1 H1 V0 Z' })).toBe(true);
    expect(squareOnHypotenuse({ ...hypotenuseSquare, rotate: 36.86989765 })).toBe(false);
  });

  it.each([
    'M0 0 L1 0 L0 1 Z',
    'M0.5 0 A0.5 0.5 0 1 1 0.5 1 A0.5 0.5 0 1 1 0.5 0 Z',
    'M0 0 L1 1 L1 0 L0 1 Z',
    'M0 0 H0.5 V1 H0 Z',
    'M0 0 H1 V1 H0',
  ])('rejects a non-square path in the correct hypotenuse box: %s', (path) => {
    expect(squareOnHypotenuse({ ...hypotenuseSquare, path })).toBe(false);
  });

  it('counts real pentagon corners and tolerates repeated closing endpoints', () => {
    expect(isPentagon(pentagon)).toBe(true);
    expect(isPentagon({ ...pentagon, path: 'M0 0 L4 0 L4 2 L2 3 L0 2 L0 0 Z' })).toBe(true);
  });

  it.each([
    'M0 0 H4 V3 H0 Z',
    'M0 0 L4 0 L4 3 L0 3 L0 0 Z',
    'M0 0 L2 0 L4 0 L4 3 L0 3 Z',
    'M0 0 L4 2 L0 2 L4 0 L2 3 Z',
    'M0 0 L4 0 L0 3 Z M1 1 L2 1 L1 2 Z',
  ])('rejects duplicate, collinear or intersecting pseudo-pentagons: %s', (path) => {
    expect(isPentagon({ ...pentagon, path })).toBe(false);
  });

  it('accepts complete circles and rejects displaced or non-circular paths', () => {
    expect(isCircle(circle, 400, 160, 60)).toBe(true);
    expect(isCircle({ ...circle, top: 40 }, 400, 160, 60)).toBe(false);
    expect(isCircle({ ...circle, path: 'M0 0 H2 V2 H0 Z' }, 400, 160, 60)).toBe(false);
  });

  it('checks rectangle edge order instead of accepting any four matching corners', () => {
    const shapes = [shape(), circle, shape({ left: 600, path: 'M0.5 0 L1 1 L0 1 Z' })];
    expect(areBasicShapes(shapes)).toBe(true);
    expect(
      areBasicShapes([{ ...shapes[0], path: 'M0 0 L1 1 L1 0 L0 1 Z' }, ...shapes.slice(1)]),
    ).toBe(false);
  });
});
