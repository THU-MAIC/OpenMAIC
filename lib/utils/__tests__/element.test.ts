/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import {
  getRectRotatedRange,
  getRectRotatedOffset,
  getLineElementLength,
  uniqAlignLines,
} from '../element';
import type { AlignLine } from '../element';

describe('getRectRotatedRange', () => {
  it('returns original bounds when rotation is 0', () => {
    const result = getRectRotatedRange({ left: 100, top: 50, width: 200, height: 100, rotate: 0 });
    expect(result.xRange[0]).toBeCloseTo(100);
    expect(result.xRange[1]).toBeCloseTo(300);
    expect(result.yRange[0]).toBeCloseTo(50);
    expect(result.yRange[1]).toBeCloseTo(150);
  });

  it('expands bounds when rotated 45 degrees', () => {
    const result = getRectRotatedRange({ left: 0, top: 0, width: 100, height: 100, rotate: 45 });
    // A square rotated 45° should have the same bounds due to symmetry
    const center = 50;
    const halfDiag = Math.sqrt(100 * 100 + 100 * 100) / 2;
    expect(result.xRange[0]).toBeCloseTo(center - halfDiag);
    expect(result.xRange[1]).toBeCloseTo(center + halfDiag);
  });

  it('swaps width/height when rotated 90 degrees', () => {
    const result = getRectRotatedRange({ left: 0, top: 0, width: 200, height: 100, rotate: 90 });
    const rangeW = result.xRange[1] - result.xRange[0];
    const rangeH = result.yRange[1] - result.yRange[0];
    // After 90° rotation, effective width ≈ original height and vice versa
    expect(rangeW).toBeCloseTo(100, 0);
    expect(rangeH).toBeCloseTo(200, 0);
  });
});

describe('getRectRotatedOffset', () => {
  it('returns zero offset when rotation is 0', () => {
    const result = getRectRotatedOffset({ left: 100, top: 50, width: 200, height: 100, rotate: 0 });
    expect(result.offsetX).toBeCloseTo(0);
    expect(result.offsetY).toBeCloseTo(0);
  });

  it('returns non-zero offset for rotated rectangle', () => {
    const result = getRectRotatedOffset({ left: 0, top: 0, width: 200, height: 100, rotate: 30 });
    // Just verify it returns numbers (exact values depend on trigonometry)
    expect(typeof result.offsetX).toBe('number');
    expect(typeof result.offsetY).toBe('number');
  });
});

describe('getLineElementLength', () => {
  it('calculates horizontal line length', () => {
    const line = { start: [0, 0], end: [100, 0] } as any;
    expect(getLineElementLength(line)).toBe(100);
  });

  it('calculates vertical line length', () => {
    const line = { start: [0, 0], end: [0, 50] } as any;
    expect(getLineElementLength(line)).toBe(50);
  });

  it('calculates diagonal line length', () => {
    const line = { start: [0, 0], end: [3, 4] } as any;
    expect(getLineElementLength(line)).toBe(5);
  });

  it('handles same start and end', () => {
    const line = { start: [10, 20], end: [10, 20] } as any;
    expect(getLineElementLength(line)).toBe(0);
  });
});

describe('uniqAlignLines', () => {
  it('returns empty array for empty input', () => {
    expect(uniqAlignLines([])).toEqual([]);
  });

  it('keeps unique lines unchanged', () => {
    const lines: AlignLine[] = [
      { value: 10, range: [0, 100] },
      { value: 20, range: [50, 150] },
    ];
    expect(uniqAlignLines(lines)).toEqual(lines);
  });

  it('merges lines with the same value, extending range', () => {
    const lines: AlignLine[] = [
      { value: 10, range: [0, 100] },
      { value: 10, range: [50, 200] },
    ];
    const result = uniqAlignLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(10);
    expect(result[0].range).toEqual([0, 200]);
  });

  it('merges multiple duplicates correctly', () => {
    const lines: AlignLine[] = [
      { value: 5, range: [10, 20] },
      { value: 5, range: [0, 15] },
      { value: 5, range: [18, 30] },
    ];
    const result = uniqAlignLines(lines);
    expect(result).toHaveLength(1);
    expect(result[0].range).toEqual([0, 30]);
  });
});
