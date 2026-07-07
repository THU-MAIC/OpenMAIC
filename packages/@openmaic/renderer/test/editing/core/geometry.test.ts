import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import {
  getElementRange,
  getElementListRange,
  getLineBounds,
  uniqAlignLines,
  pxToCanvas,
} from '../../../src/editing/core/geometry';

const box = (over: Partial<PPTElement> = {}) =>
  ({
    id: 'a',
    type: 'text',
    left: 100,
    top: 50,
    width: 200,
    height: 80,
    rotate: 0,
    ...over,
  }) as unknown as PPTElement;

describe('geometry', () => {
  it('axis-aligned range for an unrotated element', () => {
    expect(getElementRange(box())).toEqual({ minX: 100, maxX: 300, minY: 50, maxY: 130 });
  });
  it('rotated element widens the bounding range', () => {
    const r = getElementRange(box({ rotate: 90 }));
    // 90°: a 200x80 box about its center (200,90) → 80 wide, 200 tall
    expect(r.maxX - r.minX).toBeCloseTo(80, 5);
    expect(r.maxY - r.minY).toBeCloseTo(200, 5);
  });
  it('line element returns finite bounds derived from start/end (not NaN)', () => {
    const line = {
      id: 'l',
      type: 'line',
      left: 100,
      top: 50,
      start: [0, 0],
      end: [120, 40],
    } as unknown as PPTElement;
    const r = getElementRange(line);
    expect(Number.isFinite(r.minX)).toBe(true);
    expect(Number.isFinite(r.maxX)).toBe(true);
    expect(Number.isFinite(r.minY)).toBe(true);
    expect(Number.isFinite(r.maxY)).toBe(true);
    // Derived from left/top + max(start,end): x ∈ [100, 220], y ∈ [50, 90]
    expect(r).toEqual({ minX: 100, maxX: 220, minY: 50, maxY: 90 });
  });
  it('getLineBounds encloses a curve control point that leaves the chord', () => {
    const curved = {
      id: 'l',
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      end: [100, 0],
      curve: [50, 80],
    } as unknown as PPTElement & { type: 'line' };
    // start/end span only x∈[0,100] y=0 (chord is zero height); the curve
    // control point at y=80 must be enclosed.
    expect(getLineBounds(curved as never)).toEqual({ minX: 0, maxX: 100, minY: 0, maxY: 80 });
  });
  it('getLineBounds offsets every point by left/top and covers a straight chord', () => {
    const straight = {
      id: 'l',
      type: 'line',
      left: 10,
      top: 10,
      start: [0, 0],
      end: [50, 50],
    } as unknown as PPTElement & { type: 'line' };
    expect(getLineBounds(straight as never)).toEqual({ minX: 10, maxX: 60, minY: 10, maxY: 60 });
  });
  it('getLineBounds follows the rendered path for a broken2 line, not the raw control point', () => {
    // A horizontal broken2 line: the renderer's getLineElementPath draws the
    // connector flat at y=0 (it uses broken2[0] as an x, NOT broken2[1] as a
    // y), so the visible stroke has zero height even though broken2[1]=80.
    // Deriving bounds from the raw control point would wrongly report maxY=80
    // and paint an oversized selection border; the rendered path reports maxY=0.
    const horizontal = {
      id: 'l',
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      end: [100, 0],
      broken2: [50, 80],
    } as unknown as PPTElement & { type: 'line' };
    const r = getLineBounds(horizontal as never);
    expect(r.minY).toBe(0);
    // Flat: the rendered horizontal connector never reaches y=80.
    expect(r.maxY).toBe(0);
    expect(r.minX).toBe(0);
    expect(r.maxX).toBe(100);
  });
  it('getLineBounds includes broken and both cubic control points', () => {
    const broken = {
      id: 'l',
      type: 'line',
      left: 5,
      top: 5,
      start: [0, 0],
      end: [40, 10],
      broken: [20, 60],
    } as unknown as PPTElement & { type: 'line' };
    // broken point y=60 dominates the height; offset by top=5.
    expect(getLineBounds(broken as never)).toEqual({ minX: 5, maxX: 45, minY: 5, maxY: 65 });

    const cubic = {
      id: 'l',
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      end: [100, 0],
      cubic: [
        [10, -30],
        [90, 50],
      ],
    } as unknown as PPTElement & { type: 'line' };
    // Both control points count: y∈[-30,50], x∈[0,100].
    expect(getLineBounds(cubic as never)).toEqual({ minX: 0, maxX: 100, minY: -30, maxY: 50 });
  });
  it('list range is the union bbox', () => {
    expect(
      getElementListRange([box(), box({ id: 'b', left: 400, top: 0, width: 50, height: 50 })]),
    ).toEqual({ minX: 100, maxX: 450, minY: 0, maxY: 130 });
  });
  it('uniqAlignLines dedups by value and merges ranges', () => {
    expect(
      uniqAlignLines([
        { value: 10, range: [0, 5] },
        { value: 10, range: [3, 8] },
      ]),
    ).toEqual([{ value: 10, range: [0, 8] }]);
  });
  it('pxToCanvas divides by scale', () => {
    expect(pxToCanvas(50, 0.5)).toBe(100);
  });
});
