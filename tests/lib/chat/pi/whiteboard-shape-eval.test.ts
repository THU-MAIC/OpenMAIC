import type { PPTShapeElement } from '@openmaic/dsl';
import { describe, expect, it } from 'vitest';
import {
  areBasicShapes,
  assessComposition,
  hasVisibleFill,
  isCircle,
  isCurveScenarioShape,
  isPentagon,
  isRightTriangle,
  squareOnHypotenuse,
  type TriangleVertices,
} from '@/eval/whiteboard-shapes/geometry-checks';
import { compositionScenario } from '@/eval/whiteboard-shapes/composition-scenarios';

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
const curve = shape({
  path: 'M0 1 C1 0 2 0 3 1',
  viewBox: [3, 1],
  left: 100,
  top: 300,
  width: 240,
  height: 80,
  rotate: 12.5,
  fill: 'transparent',
  outline: { color: '#333333', width: 2, style: 'solid' },
});

describe('whiteboard shape evaluation geometry', () => {
  it.each([
    'none',
    'transparent',
    '#0000',
    '#00000000',
    'rgba(12, 34, 56, 0)',
    'hsla(0, 0%, 0%, 0)',
  ])('rejects an invisible SVG fill: %s', (fill) => {
    expect(hasVisibleFill(shape({ fill }))).toBe(false);
    const shapes = [shape({ fill }), circle, shape({ left: 600, path: 'M0.5 0 L1 1 L0 1 Z' })];
    expect(areBasicShapes(shapes)).toBe(false);
  });

  it.each(['red', '#123', '#123456', '#12345680', 'rgba(12, 34, 56, 0.5)'])(
    'accepts visible static SVG colors: %s',
    (fill) => expect(hasVisibleFill(shape({ fill }))).toBe(true),
  );

  it('rejects invalid colors and fully transparent elements', () => {
    expect(hasVisibleFill(shape({ fill: 'not-a-color' }))).toBe(false);
    expect(hasVisibleFill(shape({ opacity: 0 }))).toBe(false);
  });

  it('accepts the requested open cubic geometry with transparent fill and visible dark stroke', () => {
    expect(isCurveScenarioShape(curve)).toBe(true);
    expect(isCurveScenarioShape({ ...curve, fill: 'none' })).toBe(true);
    expect(isCurveScenarioShape({ ...curve, rotate: 372.5 })).toBe(true);
  });

  it.each([
    { path: 'M0 0 C1 1 2 1 3 0 Z' },
    { path: 'M0 0 C1 1 2 1 0 0' },
    { path: 'M0 1 L3 1' },
    { path: 'M0 1 C1 0 2 0 3 1 M0 0 C1 0 2 0 3 0' },
    { path: 'M0 1 C1 5 2 5 3 1' },
    { left: 10000, top: 10000 },
    { width: 1, height: 1 },
    { rotate: -12.5 },
    { fill: '#333333' },
    { opacity: 0 },
    { outline: { color: 'transparent', width: 2, style: 'solid' as const } },
    { outline: { color: '#00000000', width: 2, style: 'solid' as const } },
    { outline: { color: '#ffffff', width: 2, style: 'solid' as const } },
    { outline: { color: '#333333', width: 1, style: 'solid' as const } },
  ])('rejects a curve that violates the requested geometry or style: %j', (overrides) => {
    expect(isCurveScenarioShape({ ...curve, ...overrides })).toBe(false);
  });

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

describe('unseen 5–12–13 composition evaluation', () => {
  const vertices: TriangleVertices = [
    [300, 220],
    [492, 220],
    [300, 300],
  ];
  // Hand-computed reference contours, independent of the expected-square generator.
  const paths = [
    'M300 220 L492 220 L300 300 Z',
    'M300 220 L492 220 L492 28 L300 28 Z',
    'M492 220 L300 300 L380 492 L572 412 Z',
    'M300 300 L300 220 L220 220 L220 300 Z',
  ];
  const fromPath = (path: string) =>
    shape({
      path,
      viewBox: [1000, 562.5],
      left: 0,
      top: 0,
      width: 1000,
      height: 562.5,
    });
  const shapes = paths.map(fromPath);

  it('accepts correct geometry as separate elements or one compound path, in either winding', () => {
    expect(assessComposition(shapes, vertices).passed).toBe(true);
    expect(assessComposition([fromPath(paths.join(' '))], vertices).passed).toBe(true);
    expect(assessComposition(shapes, [vertices[0], vertices[2], vertices[1]]).passed).toBe(true);
  });

  it('scores actual transformed vertices rather than element boxes', () => {
    const rotated = shapes.map((s) => ({ ...s, rotate: 90 }));
    const rotatedVertices = vertices.map(([x, y]) => [
      500 - (y - 281.25),
      281.25 + x - 500,
    ]) as TriangleVertices;
    expect(assessComposition(rotated, rotatedVertices).passed).toBe(true);
    expect(assessComposition(rotated, vertices).passed).toBe(false);
  });

  it('rejects an inward square, crossed edges, and an unclosed contour', () => {
    for (const wrong of [
      'M300 220 L492 220 L492 412 L300 412 Z',
      'M492 220 L380 492 L300 300 L572 412 Z',
      'M492 220 L300 300 L380 492 L572 412',
    ]) {
      const invalid = [shapes[0], shapes[1], fromPath(wrong), shapes[3]];
      expect(assessComposition(invalid, vertices).passed).toBe(false);
      expect(
        assessComposition([fromPath(invalid.map((s) => s.path).join(' '))], vertices).passed,
      ).toBe(false);
    }
  });

  it('rejects missing, duplicate, extra, or invisible geometry', () => {
    expect(assessComposition(shapes.slice(0, 3), vertices).passed).toBe(false);
    expect(assessComposition([shapes[0], shapes[1], shapes[2], shapes[2]], vertices).passed).toBe(
      false,
    );
    expect(assessComposition([...shapes, shape()], vertices).passed).toBe(false);
    expect(assessComposition([...shapes, fromPath('M0 0 L1 1')], vertices).passed).toBe(false);
    expect(
      assessComposition(
        shapes.map((s) => ({ ...s, fill: 'transparent' })),
        vertices,
      ).passed,
    ).toBe(false);
  });

  it('rejects an otherwise correct composition outside the canvas', () => {
    const shifted = shapes.map((s) => ({ ...s, left: 1000 }));
    const shiftedVertices = vertices.map(([x, y]) => [x + 1000, y]) as TriangleVertices;
    expect(assessComposition(shifted, shiftedVertices).withinCanvas).toBe(false);
    expect(assessComposition(shifted, shiftedVertices).passed).toBe(false);
  });

  it.each(['none', '#0000', '#00000000', 'rgba(12, 34, 56, 0)', 'hsla(0, 0%, 0%, 0)'])(
    'rejects geometrically correct compositions with invisible fill %s',
    (fill) => {
      expect(
        assessComposition(
          shapes.map((s) => ({ ...s, fill })),
          vertices,
        ).passed,
      ).toBe(false);
      expect(assessComposition([{ ...fromPath(paths.join(' ')), fill }], vertices).passed).toBe(
        false,
      );
    },
  );

  it('rejects geometrically correct but fully transparent elements', () => {
    expect(
      assessComposition(
        shapes.map((s) => ({ ...s, opacity: 0 })),
        vertices,
      ).passed,
    ).toBe(false);
  });

  it.each([0, 1, 2, 3])(
    'keeps the 5–12–13 ratio in variant %i without disclosing square placements',
    (variant) => {
      const scenario = compositionScenario(variant);
      const [a, b, c] = scenario.vertices;
      const length = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
      expect(length(a, b) / length(a, c)).toBeCloseTo(12 / 5, 3);
      expect(length(b, c) / length(a, c)).toBeCloseTo(13 / 5, 3);
      expect(scenario.request).not.toMatch(/viewBox|path:|rotate:|正方形.*\d/);
    },
  );
});
