import { describe, it, expect } from 'vitest';
import type { PPTElement, PPTLineElement } from '@openmaic/dsl';
import {
  getEditingElementRange,
  getEditingElementListRange,
  getElementRange,
  getElementListRange,
  getVisualElementRange,
  uniqAlignLines,
  pxToCanvas,
} from '../../../src/editing/core/geometry';
import { getLineElementPath } from '../../../src/utils/element';

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
  it('editing range includes a line curve control point beyond the chord', () => {
    const line = {
      id: 'curve',
      type: 'line',
      left: 100,
      top: 50,
      start: [0, 0],
      end: [120, 0],
      curve: [60, 80],
    } as unknown as PPTElement;
    expect(getElementRange(line)).toEqual({ minX: 100, maxX: 220, minY: 50, maxY: 50 });
    expect(getEditingElementRange(line)).toEqual({ minX: 100, maxX: 220, minY: 50, maxY: 130 });
  });
  it('visual range for a quadratic curve uses the Bezier extremum, not the control hull', () => {
    const line = {
      id: 'curve',
      type: 'line',
      left: 100,
      top: 50,
      start: [0, 0],
      end: [120, 20],
      curve: [60, 80],
    } as unknown as PPTElement;
    const t = (0 - 80) / (0 - 2 * 80 + 20);
    const expectedMaxY = 50 + 2 * (1 - t) * t * 80 + t * t * 20;

    expect(getEditingElementRange(line).maxY).toBe(130);
    const visual = getVisualElementRange(line);
    expect(visual.minY).toBe(50);
    expect(visual.maxY).toBeCloseTo(expectedMaxY, 5);
    expect(visual.maxY).not.toBe(130);
  });
  it('visual range for a cubic curve includes both derivative roots per axis', () => {
    const line = {
      id: 'cubic',
      type: 'line',
      left: 10,
      top: 20,
      start: [0, 0],
      end: [100, 0],
      cubic: [
        [0, 120],
        [100, -60],
      ],
    } as unknown as PPTElement;

    const visual = getVisualElementRange(line);
    expect(visual.minY).toBeLessThan(20);
    expect(visual.maxY).toBeGreaterThan(20);
    expect(visual.maxY).toBeLessThan(140);
    expect(visual.minY).toBeGreaterThan(-40);
  });
  it('visual range for a polyline includes its rendered elbow vertex', () => {
    const line = {
      id: 'broken',
      type: 'line',
      left: 100,
      top: 50,
      start: [0, 0],
      end: [120, 20],
      broken: [80, 140],
    } as unknown as PPTElement;
    expect(getVisualElementRange(line)).toEqual({ minX: 100, maxX: 220, minY: 50, maxY: 190 });
  });
  it('visual range for broken2 follows the rendered orthogonal elbows', () => {
    const line = {
      id: 'broken2',
      type: 'line',
      left: 100,
      top: 50,
      start: [0, 0],
      end: [120, 20],
      broken2: [80, 140],
    } as unknown as PPTLineElement;

    expect(getLineElementPath(line)).toBe('M0,0 L80,0 L80,20 120,20');
    expect(getVisualElementRange(line)).toEqual({ minX: 100, maxX: 220, minY: 50, maxY: 70 });
  });
  it('visual range for non-line elements delegates to the shared element range', () => {
    const element = box({ rotate: 15 });
    expect(getVisualElementRange(element)).toEqual(getElementRange(element));
  });
  it('list range is the union bbox', () => {
    expect(
      getElementListRange([box(), box({ id: 'b', left: 400, top: 0, width: 50, height: 50 })]),
    ).toEqual({ minX: 100, maxX: 450, minY: 0, maxY: 130 });
  });
  it('editing list range unions line control points with box ranges', () => {
    const line = {
      id: 'curve',
      type: 'line',
      left: 400,
      top: 20,
      start: [0, 0],
      end: [60, 0],
      curve: [30, 160],
    } as unknown as PPTElement;
    expect(getEditingElementListRange([box(), line])).toEqual({
      minX: 100,
      maxX: 460,
      minY: 20,
      maxY: 180,
    });
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
