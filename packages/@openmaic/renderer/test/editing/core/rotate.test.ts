import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { computeRotate, canRotate } from '../../../src/editing/core/rotate';

// Box 200x80 at (100, 100): center (200, 140). All pointer positions below are
// canvas coordinates around that center.
const box = { left: 100, top: 100, width: 200, height: 80 };

const rotate = (x: number, y: number) => computeRotate({ element: box, pointerCanvas: { x, y } });

describe('computeRotate', () => {
  it('is 0 when the pointer sits straight above the center', () => {
    expect(rotate(200, 40)).toBe(0);
  });

  it('measures clockwise-positive: pointer to the right of the center is +90', () => {
    expect(rotate(300, 140)).toBe(90);
  });

  it('stays SIGNED: pointer to the left of the center is -90, not 270', () => {
    expect(rotate(100, 140)).toBe(-90);
  });

  it('pointer straight below the center is 180 (atan2 upper seam)', () => {
    expect(rotate(200, 240)).toBe(180);
  });

  it('leaves angles outside the snap range untouched', () => {
    // 30° ray: center + 100 * (sin 30, -cos 30).
    const a = rotate(200 + 100 * Math.sin(Math.PI / 6), 140 - 100 * Math.cos(Math.PI / 6));
    expect(a).toBeCloseTo(30, 5);
  });

  it('snaps to 45 within the 5-degree range', () => {
    // 43° ray → within 5° of 45 → snapped.
    const rad = (43 * Math.PI) / 180;
    expect(rotate(200 + 100 * Math.sin(rad), 140 - 100 * Math.cos(rad))).toBe(45);
  });

  it('snaps negative angles to the negative multiples (-48 → -45)', () => {
    const rad = (-48 * Math.PI) / 180;
    expect(rotate(200 + 100 * Math.sin(rad), 140 - 100 * Math.cos(rad))).toBe(-45);
  });

  it('snaps small angles to 0', () => {
    const rad = (3 * Math.PI) / 180;
    expect(rotate(200 + 100 * Math.sin(rad), 140 - 100 * Math.cos(rad))).toBe(0);
  });

  it('snaps near the ±180 seam', () => {
    const rad = (177 * Math.PI) / 180;
    expect(rotate(200 + 100 * Math.sin(rad), 140 - 100 * Math.cos(rad))).toBe(180);
    const negRad = (-176 * Math.PI) / 180;
    expect(rotate(200 + 100 * Math.sin(negRad), 140 - 100 * Math.cos(negRad))).toBe(-180);
  });
});

describe('canRotate — per-kind gate', () => {
  const el = (type: string) => ({ type }) as unknown as PPTElement;

  it('allows text, image, shape, table, latex', () => {
    for (const type of ['text', 'image', 'shape', 'table', 'latex']) {
      expect(canRotate(el(type))).toBe(true);
    }
  });

  it('blocks chart, video, audio, code, line', () => {
    for (const type of ['chart', 'video', 'audio', 'code', 'line']) {
      expect(canRotate(el(type))).toBe(false);
    }
  });
});
