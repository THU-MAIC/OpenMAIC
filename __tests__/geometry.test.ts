import { describe, it, expect } from 'vitest';
import {
  getElementPercentageGeometry,
  findElementGeometry,
  findNearestCorner,
} from '../lib/utils/geometry';

describe('geometry.ts', () => {
  describe('getElementPercentageGeometry', () => {
    it('should calculate percentage geometry for positioned element', () => {
      const element = {
        id: 'test',
        left: 100,
        top: 50,
        width: 200,
        height: 100,
      };

      const result = getElementPercentageGeometry(element as never, 1000);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.x).toBe(10);
        expect(result.y).toBe(8.89); // 50 / (1000 * 0.5625) * 100
        expect(result.w).toBe(20);
        expect(result.h).toBe(17.78); // 100 / (1000 * 0.5625) * 100
        expect(result.centerX).toBe(20);
        expect(result.centerY).toBe(17.78);
      }
    });

    it('should return null for non-positioned element', () => {
      const element = {
        id: 'test',
        type: 'text',
        content: 'Hello',
      };

      const result = getElementPercentageGeometry(element as never);
      expect(result).toBeNull();
    });

    it('should use default viewport size of 1000', () => {
      const element = {
        id: 'test',
        left: 500,
        top: 250,
        width: 100,
        height: 50,
      };

      const result = getElementPercentageGeometry(element as never);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.x).toBe(50);
        expect(result.w).toBe(10);
      }
    });
  });

  describe('findElementGeometry', () => {
    it('should find element in old format scene', () => {
      const scene = {
        type: 'slide',
        elements: [
          { id: 'el1', left: 100, top: 50, width: 200, height: 100 },
        ],
      };

      const result = findElementGeometry(scene as never, 'el1', 1000);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.x).toBe(10);
      }
    });

    it('should find element in new format scene', () => {
      const scene = {
        type: 'slide',
        content: {
          canvas: {
            elements: [
              { id: 'el2', left: 200, top: 100, width: 300, height: 150 },
            ],
          },
        },
      };

      const result = findElementGeometry(scene as never, 'el2', 1000);

      expect(result).not.toBeNull();
      if (result) {
        expect(result.x).toBe(20);
      }
    });

    it('should return null for non-existent element', () => {
      const scene = {
        type: 'slide',
        elements: [{ id: 'el1', left: 100, top: 50, width: 200, height: 100 }],
      };

      const result = findElementGeometry(scene as never, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should return null for invalid scene format', () => {
      const scene = { type: 'other' };

      const result = findElementGeometry(scene as never, 'el1');
      expect(result).toBeNull();
    });
  });

  describe('findNearestCorner', () => {
    it('should find top-left corner for element near top-left', () => {
      const geometry = { centerX: 10, centerY: 10, x: 0, y: 0, w: 20, h: 20 };

      const result = findNearestCorner(geometry);

      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });

    it('should find bottom-right corner for element near bottom-right', () => {
      const geometry = { centerX: 90, centerY: 90, x: 80, y: 80, w: 20, h: 20 };

      const result = findNearestCorner(geometry);

      expect(result.x).toBe(100);
      expect(result.y).toBe(100);
    });

    it('should find top-right corner for element near top-right', () => {
      const geometry = { centerX: 90, centerY: 10, x: 80, y: 0, w: 20, h: 20 };

      const result = findNearestCorner(geometry);

      expect(result.x).toBe(100);
      expect(result.y).toBe(0);
    });

    it('should find bottom-left corner for element near bottom-left', () => {
      const geometry = { centerX: 10, centerY: 90, x: 0, y: 80, w: 20, h: 20 };

      const result = findNearestCorner(geometry);

      expect(result.x).toBe(0);
      expect(result.y).toBe(100);
    });

    it('should handle center element (tie-breaker prefers top-left)', () => {
      const geometry = { centerX: 50, centerY: 50, x: 40, y: 40, w: 20, h: 20 };

      const result = findNearestCorner(geometry);

      // At equal distance, order is: top-left, top-right, bottom-left, bottom-right
      expect(result.x).toBe(0);
      expect(result.y).toBe(0);
    });
  });
});