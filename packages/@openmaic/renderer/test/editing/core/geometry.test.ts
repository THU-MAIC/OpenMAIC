import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import {
  getElementRange,
  getElementListRange,
  getLineBounds,
  uniqAlignLines,
  pxToCanvas,
  quadraticBounds,
  cubicBounds,
  getPathBounds,
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
  it('getLineBounds bounds the TRUE quadratic curve, not the raw control point', () => {
    const curved = {
      id: 'l',
      type: 'line',
      left: 0,
      top: 0,
      start: [0, 0],
      end: [100, 0],
      curve: [50, 80],
    } as unknown as PPTElement & { type: 'line' };
    // Path: M0,0 Q50,80 100,0. The control point sits at y=80 but the drawn
    // quadratic only reaches its peak y=40 at t=0.5, so the tight bbox is 40
    // tall — half the naive control-point height. x stays [0,100] (no interior
    // x extremum: the x control is on the chord midline).
    expect(getLineBounds(curved as never)).toEqual({ minX: 0, maxX: 100, minY: 0, maxY: 40 });
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
  it('getLineBounds inflates by half the rendered stroke width', () => {
    // A thick horizontal line: the centerline is flat (minY === maxY on the
    // path), but the rendered stroke (strokeWidth = width) extends width/2 above
    // and below it, so the border must grow by half the width on every side.
    const thick = {
      id: 'l',
      type: 'line',
      left: 0,
      top: 0,
      width: 10,
      start: [0, 0],
      end: [100, 0],
    } as unknown as PPTElement & { type: 'line' };
    expect(getLineBounds(thick as never)).toEqual({ minX: -5, maxX: 105, minY: -5, maxY: 5 });
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
    // Path: M0,0 C10,-30 90,50 100,0. The raw control points reach y∈[-30,50],
    // but the drawn cubic never gets that far. B'(t)=0 on the y-axis has roots
    // t=1/6 and t=3/4; evaluating the cubic there gives the true extrema
    // y=-6.9444… (min, at t=1/6) and y=16.875 (max, at t=3/4). x is monotonic
    // over [0,100] (no root of B'(t)=0 in (0,1)).
    const cb = getLineBounds(cubic as never);
    expect(cb.minX).toBeCloseTo(0, 6);
    expect(cb.maxX).toBeCloseTo(100, 6);
    expect(cb.minY).toBeCloseTo(-6.944444, 5);
    expect(cb.maxY).toBeCloseTo(16.875, 6);
  });

  it('quadraticBounds returns endpoints plus the interior extremum, not the control point', () => {
    // p0=0, control p1=80, p2=0: peak at t=0.5 is B(0.5)=40, NOT 80.
    expect(quadraticBounds(0, 80, 0)).toEqual([0, 40]);
    // Monotonic axis (control on the chord line): just the endpoints, no interior
    // extremum because the denominator p0-2p1+p2 = 0.
    expect(quadraticBounds(0, 50, 100)).toEqual([0, 100]);
    // Control between the endpoints on a monotone segment: still just endpoints.
    expect(quadraticBounds(0, 20, 100)).toEqual([0, 100]);
  });

  it('cubicBounds solves B′(t)=0 for the tight extrema, handling the degenerate a≈0 case', () => {
    // Symmetric y controls 0,90,90,0: a = -p0+3p1-3p2+p3 = 0 (degenerate/linear
    // derivative), single root t=0.5, B(0.5)=67.5 — the true peak, NOT 90.
    const [lo, hi] = cubicBounds(0, 90, 90, 0);
    expect(lo).toBeCloseTo(0, 6);
    expect(hi).toBeCloseTo(67.5, 6);
    // Asymmetric case with two interior roots (t=1/6, t=3/4).
    const [lo2, hi2] = cubicBounds(0, -30, 50, 0);
    expect(lo2).toBeCloseTo(-6.944444, 5);
    expect(hi2).toBeCloseTo(16.875, 6);
    // Straight cubic (all collinear on one axis): just the endpoints.
    expect(cubicBounds(0, 25, 75, 100)).toEqual([0, 100]);
  });

  it('getPathBounds computes a tight bbox for a full path with implicit L repeats', () => {
    // Quadratic peak case, in path form.
    expect(getPathBounds('M0,0 Q50,80 100,0')).toEqual({
      minX: 0,
      maxX: 100,
      minY: 0,
      maxY: 40,
    });
    // Implicit L repeat (broken2-style): "L50,0 100,0" — the second pair repeats
    // the L command, so it stays flat at y=0.
    expect(getPathBounds('M0,0 L50,0 L50,0 100,0')).toEqual({
      minX: 0,
      maxX: 100,
      minY: 0,
      maxY: 0,
    });
    // Cubic symmetric peak → 67.5, not 90.
    const c = getPathBounds('M0,0 C30,90 70,90 100,0');
    expect(c).not.toBeNull();
    expect(c!.maxY).toBeCloseTo(67.5, 6);
    expect(c!.minY).toBeCloseTo(0, 6);
    // Empty/degenerate path → null.
    expect(getPathBounds('')).toBeNull();
  });
  it('getPathBounds parses exponent-form coordinates as single numbers', () => {
    // A rotated/imported line can stringify a near-zero coord in exponent form;
    // `7.105427357601002e-15` must parse as one ~0 number, not `7.1` and `-15`
    // (the old regex would have made minX = -15).
    const r = getPathBounds('M7.105427357601002e-15,0 L100,50');
    expect(r).not.toBeNull();
    expect(r!.minX).toBeCloseTo(0, 6);
    expect(r!.maxX).toBe(100);
    expect(r!.minY).toBe(0);
    expect(r!.maxY).toBe(50);
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
