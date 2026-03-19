import { describe, it, expect } from 'vitest';
import {
  getRectRotatedRange,
  getRectRotatedOffset,
  getElementRange,
  getElementListRange,
  getLineElementLength,
  uniqAlignLines,
} from '../lib/utils/element';

describe('element.ts', () => {
  describe('getRectRotatedRange', () => {
    it('should calculate range for non-rotated element', () => {
      const element = { left: 0, top: 0, width: 100, height: 50, rotate: 0 };

      const result = getRectRotatedRange(element);

      expect(result.xRange).toEqual([0, 100]);
      expect(result.yRange).toEqual([0, 50]);
    });

    it('should calculate range for 90-degree rotated element', () => {
      const element = { left: 0, top: 0, width: 100, height: 50, rotate: 90 };

      const result = getRectRotatedRange(element);

      expect(result.xRange[0]).toBeLessThan(result.xRange[1]);
      expect(result.yRange[0]).toBeLessThan(result.yRange[1]);
      // After 90° rotation, width and height should be swapped conceptually
    });

    it('should handle element with default rotate (0)', () => {
      const element = { left: 50, top: 50, width: 200, height: 100 };

      const result = getRectRotatedRange(element);

      expect(result.xRange).toEqual([50, 250]);
      expect(result.yRange).toEqual([50, 150]);
    });
  });

  describe('getRectRotatedOffset', () => {
    it('should return zero offset for non-rotated element', () => {
      const element = { left: 100, top: 100, width: 50, height: 30, rotate: 0 };

      const result = getRectRotatedOffset(element);

      expect(result.offsetX).toBe(0);
      expect(result.offsetY).toBe(0);
    });

    it('should return non-zero offset for rotated element', () => {
      const element = { left: 100, top: 100, width: 50, height: 30, rotate: 45 };

      const result = getRectRotatedOffset(element);

      // After rotation, the bounding box should be larger
      expect(result.offsetX).not.toBe(0);
      expect(result.offsetY).not.toBe(0);
    });
  });

  describe('getElementRange', () => {
    it('should calculate range for rectangular element', () => {
      const element = { id: 'test', type: 'rect', left: 10, top: 20, width: 100, height: 50 };

      const result = getElementRange(element as never);

      expect(result.minX).toBe(10);
      expect(result.maxX).toBe(110);
      expect(result.minY).toBe(20);
      expect(result.maxY).toBe(70);
    });

    it('should calculate range for line element', () => {
      const element = {
        id: 'line1',
        type: 'line',
        left: 0,
        top: 0,
        start: [0, 0],
        end: [100, 50],
      };

      const result = getElementRange(element as never);

      expect(result.minX).toBe(0);
      expect(result.maxX).toBe(100);
      expect(result.minY).toBe(0);
      expect(result.maxY).toBe(50);
    });

    it('should handle rotated element', () => {
      const element = {
        id: 'rotated',
        type: 'rect',
        left: 50,
        top: 50,
        width: 100,
        height: 50,
        rotate: 45,
      };

      const result = getElementRange(element as never);

      // Rotated element should have expanded bounding box
      expect(result.minX).toBeLessThan(50);
      expect(result.maxX).toBeGreaterThan(150);
    });
  });

  describe('getElementListRange', () => {
    it('should calculate combined range for multiple elements', () => {
      const elements = [
        { id: 'el1', type: 'rect', left: 0, top: 0, width: 50, height: 50 },
        { id: 'el2', type: 'rect', left: 100, top: 100, width: 50, height: 50 },
      ];

      const result = getElementListRange(elements as never[]);

      expect(result.minX).toBe(0);
      expect(result.maxX).toBe(150);
      expect(result.minY).toBe(0);
      expect(result.maxY).toBe(150);
    });

    it('should handle single element', () => {
      const elements = [
        { id: 'el1', type: 'rect', left: 10, top: 20, width: 100, height: 80 },
      ];

      const result = getElementListRange(elements as never[]);

      expect(result.minX).toBe(10);
      expect(result.maxX).toBe(110);
      expect(result.minY).toBe(20);
      expect(result.maxY).toBe(100);
    });
  });

  describe('getLineElementLength', () => {
    it('should calculate horizontal line length', () => {
      const element = { id: 'line', type: 'line', start: [0, 0], end: [100, 0] };

      const result = getLineElementLength(element as never);

      expect(result).toBe(100);
    });

    it('should calculate vertical line length', () => {
      const element = { id: 'line', type: 'line', start: [0, 0], end: [0, 50] };

      const result = getLineElementLength(element as never);

      expect(result).toBe(50);
    });

    it('should calculate diagonal line length', () => {
      const element = { id: 'line', type: 'line', start: [0, 0], end: [30, 40] };

      const result = getLineElementLength(element as never);

      expect(result).toBe(50); // 3-4-5 triangle
    });
  });

  describe('uniqAlignLines', () => {
    it('should deduplicate lines with same value', () => {
      const lines = [
        { value: 50, range: [0, 10] as [number, number] },
        { value: 50, range: [5, 15] as [number, number] },
        { value: 100, range: [20, 30] as [number, number] },
      ];

      const result = uniqAlignLines(lines);

      expect(result).toHaveLength(2);
      expect(result.find((l) => l.value === 50)?.range).toEqual([0, 15]);
    });

    it('should keep all unique values', () => {
      const lines = [
        { value: 10, range: [0, 5] as [number, number] },
        { value: 20, range: [5, 10] as [number, number] },
        { value: 30, range: [10, 15] as [number, number] },
      ];

      const result = uniqAlignLines(lines);

      expect(result).toHaveLength(3);
    });

    it('should handle empty array', () => {
      const lines: { value: number; range: [number, number] }[] = [];

      const result = uniqAlignLines(lines);

      expect(result).toHaveLength(0);
    });
  });
});