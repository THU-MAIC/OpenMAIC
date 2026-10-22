import { describe, expect, it, vi } from 'vitest';
import { SVGPathData } from 'svg-pathdata';
import { shapeGeometryChanged, validateSvgPath, validateShapeGeometry } from '../src/index.js';
import type { PPTShapeElement } from '@openmaic/dsl';

describe('SVG path validation', () => {
  it.each([
    'M0 0 L100 0 50 100 Z',
    'm1e1 -2E+1 10 0 0 10z',
    'M0,0 h10 v10 l-10 0z',
    'M.6.5 C1 2 3 4 5 6 S7 8 9 10 Q11 12 13 14 T15 16',
    'M0 0 A10 20 30 0110 20 a1 2 0 1 0 -2 -3',
    'M01 002 L000 000',
    'M0 0 A0 10 0 0 0 10 10',
    'M0 0 A10 10 0 0 0 0 0',
    'M0 0 Z M1 1 L2 2',
    'M0 0',
    'M0 0 L0 0',
    '',
    '  ',
    'M0\f0 L10\f10',
  ])('accepts standard path without changing its input: %s', (path) => {
    const result = validateSvgPath(path);
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    'M 0 0 Z 1 1',
    'M0 0 Z1',
    'M0 0 Z,',
    'M0',
    'M0 0 L',
    'M0 0 C1 2 3 4',
    'M0 0 A1 1 0 2 0 10 10',
    'M0 0 A1 1 0010 10',
    'M0 0 A-1 1 0 0 0 10 10',
    'M,0 0',
    'M0,,0',
    'M0 0,',
    'M0 0 L1 1 garbage',
    '<svg><path d="M0 0"/></svg>',
    'L0 0',
    'Z',
    'NaN',
    'M0 0 L1e999 0',
    'M0 0 L1e+ 0',
    'M0 0 L1e2e3 0',
  ])('returns an explicit error for %s', (path) => {
    const result = validateSvgPath(path);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        field: 'path',
        message: expect.any(String),
        position: expect.any(Number),
      });
  });

  it('reports a missing command parameter before a separator error', () => {
    expect(validateSvgPath('M0 0 L10')).toMatchObject({
      ok: false,
      error: { code: 'syntax', field: 'path', message: 'Expected parameter 2 of L', position: 8 },
    });
  });

  it('rejects excessive length before reaching the dependency parser', () => {
    const parser = vi.spyOn(SVGPathData, 'parse');
    expect(validateSvgPath('M0 0' + ' L1 1'.repeat(100), { maxLength: 10 })).toMatchObject({
      ok: false,
      error: { code: 'resource_limit' },
    });
    expect(parser).not.toHaveBeenCalled();
    parser.mockRestore();
  });

  it('limits implicit repetition, raw and accumulated coordinates', () => {
    expect(validateSvgPath('M0 0 1 1 2 2', { maxCommands: 2 })).toMatchObject({
      ok: false,
      error: { code: 'resource_limit' },
    });
    expect(validateSvgPath('M0 0 L100 0', { maxCoordinate: 10 })).toMatchObject({
      ok: false,
      error: { code: 'resource_limit' },
    });
    expect(validateSvgPath('m8 8 l8 8', { maxCoordinate: 10 })).toMatchObject({
      ok: false,
      error: { code: 'resource_limit' },
    });
    expect(validateSvgPath('M1e308 0 l1e308 0', { maxCoordinate: Infinity })).toMatchObject({
      ok: false,
      error: { code: 'non_finite' },
    });
  });

  it('distinguishes empty and degenerate geometry from failure', () => {
    expect(validateSvgPath('')).toMatchObject({ ok: true, bounds: null });
    expect(validateSvgPath('M5 5 L5 5')).toMatchObject({
      ok: true,
      bounds: { minX: 5, minY: 5, maxX: 5, maxY: 5 },
    });
    expect(validateSvgPath('M10 10 l20 30')).toMatchObject({
      ok: true,
      bounds: { minX: 10, minY: 10, maxX: 30, maxY: 40 },
    });
  });

  it.each(['M0 0 A0 10 0 0 0 10 10', 'M0 0 A10 0 0 0 0 10 10', 'M0 0 A0 0 0 0 0 10 10'])(
    'treats a zero-radius arc as a line: %s',
    (path) => {
      expect(validateSvgPath(path)).toMatchObject({
        ok: true,
        bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      });
      expect(
        validateShapeGeometry({ path, viewBox: [10, 10], width: 100, height: 100 }),
      ).toMatchObject({ ok: true });
    },
  );

  it('preserves the bulge of tiny arcs and rejects computation overflow explicitly', () => {
    const tiny = validateSvgPath('M0 0 A1e-12 1e-12 0 0 1 2e-12 0');
    expect(tiny.ok).toBe(true);
    if (tiny.ok) expect(tiny.bounds!.minY).toBeLessThan(-0.9e-12);
    expect(
      validateSvgPath('M0 0 A1e308 1e308 0 0 0 10 10', { maxCoordinate: Infinity }),
    ).toMatchObject({ ok: false, error: { code: 'non_finite' } });
  });
});

describe('shape geometry', () => {
  const shape = {
    path: 'M0 0 L10 10',
    viewBox: [10, 10] as [number, number],
    width: 100,
    height: 100,
  };
  it.each([0, -1, Infinity, NaN])('rejects dimension %s', (dimension) => {
    expect(validateShapeGeometry({ ...shape, viewBox: [dimension, 10] })).toMatchObject({
      ok: false,
      error: { field: 'viewBox[0]' },
    });
    expect(validateShapeGeometry({ ...shape, width: dimension })).toMatchObject({
      ok: false,
      error: { field: 'width' },
    });
  });
  it('rejects non-finite scaling and scaled overflow', () => {
    expect(validateShapeGeometry({ ...shape, viewBox: [Number.MIN_VALUE, 10] })).toMatchObject({
      ok: false,
      error: { code: 'non_finite' },
    });
    expect(validateShapeGeometry({ ...shape, viewBox: [1e-9, 10] })).toMatchObject({
      ok: false,
      error: { code: 'resource_limit' },
    });
  });
  it('recognizes changes to every entry of a malformed historical viewBox', () => {
    const before = { ...shape, viewBox: [10, 10, 1] } as unknown as PPTShapeElement;
    const after = { ...before, viewBox: [10, 10, 2] } as unknown as PPTShapeElement;
    expect(shapeGeometryChanged(before, after)).toBe(true);
    expect(validateShapeGeometry(after)).toMatchObject({
      ok: false,
      error: { field: 'viewBox' },
    });
  });
  it('allows style edits when non-finite historical geometry is unchanged', () => {
    const before = { ...shape, viewBox: [NaN, 10] } as PPTShapeElement;
    const after = { ...before, viewBox: [NaN, 10] as [number, number], fill: '#123456' };
    expect(shapeGeometryChanged(before, after)).toBe(false);
  });
});
