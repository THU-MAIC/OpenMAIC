import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import {
  getElementRange,
  getElementListRange,
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
