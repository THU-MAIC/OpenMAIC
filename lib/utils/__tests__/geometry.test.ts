/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { getElementPercentageGeometry, findElementGeometry, findNearestCorner } from '../geometry';

describe('getElementPercentageGeometry', () => {
  it('returns percentage geometry for a positioned element', () => {
    const element = {
      id: '1',
      type: 'shape',
      left: 100,
      top: 56.25,
      width: 500,
      height: 281.25,
    } as any;
    const result = getElementPercentageGeometry(element, 1000);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(10); // 100/1000*100
    expect(result!.y).toBe(10); // 56.25/562.5*100
    expect(result!.w).toBe(50); // 500/1000*100
    expect(result!.h).toBe(50); // 281.25/562.5*100
    expect(result!.centerX).toBe(35); // 10 + 50/2
    expect(result!.centerY).toBe(35); // 10 + 50/2
  });

  it('returns null for elements without position properties', () => {
    const element = { id: '1', type: 'audio' } as any;
    expect(getElementPercentageGeometry(element)).toBeNull();
  });

  it('uses default viewportSize of 1000', () => {
    const element = {
      id: '1',
      type: 'shape',
      left: 500,
      top: 281.25,
      width: 200,
      height: 112.5,
    } as any;
    const result = getElementPercentageGeometry(element);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(50);
    expect(result!.y).toBe(50);
  });
});

describe('findElementGeometry', () => {
  const elements = [
    { id: 'el-1', type: 'text', left: 0, top: 0, width: 1000, height: 562.5 },
    { id: 'el-2', type: 'shape', left: 250, top: 140.625, width: 500, height: 281.25 },
  ];

  it('finds element in old format scene', () => {
    const scene = { type: 'slide', elements };
    const result = findElementGeometry(scene, 'el-2', 1000);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(25);
    expect(result!.y).toBe(25);
  });

  it('finds element in new format scene', () => {
    const scene = { type: 'slide', content: { canvas: { elements } } };
    const result = findElementGeometry(scene, 'el-1', 1000);
    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
  });

  it('returns null for non-slide scene', () => {
    const scene = { type: 'other', elements };
    expect(findElementGeometry(scene, 'el-1')).toBeNull();
  });

  it('returns null for missing element ID', () => {
    const scene = { type: 'slide', elements };
    expect(findElementGeometry(scene, 'nonexistent')).toBeNull();
  });
});

describe('findNearestCorner', () => {
  it('returns top-left for element in top-left quadrant', () => {
    const corner = findNearestCorner({ x: 0, y: 0, w: 20, h: 20, centerX: 10, centerY: 10 });
    expect(corner).toEqual({ x: 0, y: 0 });
  });

  it('returns top-right for element in top-right quadrant', () => {
    const corner = findNearestCorner({ x: 80, y: 0, w: 20, h: 20, centerX: 90, centerY: 10 });
    expect(corner).toEqual({ x: 100, y: 0 });
  });

  it('returns bottom-left for element in bottom-left quadrant', () => {
    const corner = findNearestCorner({ x: 0, y: 80, w: 20, h: 20, centerX: 10, centerY: 90 });
    expect(corner).toEqual({ x: 0, y: 100 });
  });

  it('returns bottom-right for element in bottom-right quadrant', () => {
    const corner = findNearestCorner({ x: 80, y: 80, w: 20, h: 20, centerX: 90, centerY: 90 });
    expect(corner).toEqual({ x: 100, y: 100 });
  });
});
