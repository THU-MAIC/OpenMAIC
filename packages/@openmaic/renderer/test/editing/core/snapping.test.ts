import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { buildAlignLines, snapRange } from '../../../src/editing/core/snapping';

const el = (o: Partial<PPTElement>) =>
  ({ id: 'x', type: 'text', rotate: 0, ...o }) as unknown as PPTElement;
const vp = { width: 1000, height: 562 };

describe('snapping', () => {
  it('builds viewport lines when toCanvas is on', () => {
    const { vertical } = buildAlignLines([], vp, { toCanvas: true, toElements: false });
    expect(vertical.map((l) => l.value)).toEqual(expect.arrayContaining([0, 500, 1000]));
  });
  it('builds element edge + center lines when toElements is on', () => {
    const { vertical } = buildAlignLines([el({ left: 100, top: 0, width: 200, height: 50 })], vp, {
      toElements: true,
      toCanvas: false,
    });
    expect(vertical.map((l) => l.value)).toEqual(expect.arrayContaining([100, 200, 300])); // left,center,right
  });
  it('builds candidate lines from a curve visual range, not the control hull', () => {
    const curveLine = {
      id: 'line',
      type: 'line',
      left: 100,
      top: 50,
      start: [0, 0],
      end: [120, 20],
      curve: [60, 80],
      width: 2,
      style: 'solid',
      color: '#333',
      points: ['', ''],
    } as unknown as PPTElement;
    const t = (0 - 80) / (0 - 2 * 80 + 20);
    const expectedMaxY = 50 + 2 * (1 - t) * t * 80 + t * t * 20;

    const { horizontal } = buildAlignLines([curveLine], vp, {
      toElements: true,
      toCanvas: false,
    });
    expect(horizontal.map((l) => l.value)).toContain(50);
    expect(horizontal.find((l) => Math.abs(l.value - expectedMaxY) < 1e-9)?.value).toBeCloseTo(
      expectedMaxY,
      5,
    );
    expect(horizontal.some((l) => l.value === 130)).toBe(false);
  });
  it('builds candidate lines from polyline elbow vertices', () => {
    const brokenLine = {
      id: 'line',
      type: 'line',
      left: 100,
      top: 50,
      start: [0, 0],
      end: [120, 20],
      broken: [80, 140],
      width: 2,
      style: 'solid',
      color: '#333',
      points: ['', ''],
    } as unknown as PPTElement;
    const { horizontal } = buildAlignLines([brokenLine], vp, {
      toElements: true,
      toCanvas: false,
    });
    expect(horizontal.map((l) => l.value)).toEqual(expect.arrayContaining([50, 120, 190]));
  });
  it('builds candidate lines for non-line elements unchanged', () => {
    const { vertical, horizontal } = buildAlignLines(
      [el({ left: 100, top: 50, width: 200, height: 80 })],
      vp,
      {
        toElements: true,
        toCanvas: false,
      },
    );
    expect(vertical.map((l) => l.value)).toEqual(expect.arrayContaining([100, 200, 300]));
    expect(horizontal.map((l) => l.value)).toEqual(expect.arrayContaining([50, 90, 130]));
  });
  it('snaps a target within range and reports a guide', () => {
    const lines = buildAlignLines([], vp, { toCanvas: true });
    const target = { minX: 3, maxX: 203, minY: 100, maxY: 180 }; // left edge 3px from x=0
    const { dx, guides } = snapRange(target, lines, 5);
    expect(dx).toBe(-3);
    expect(guides.some((g) => g.type === 'vertical' && g.axis.x === 0)).toBe(true);
  });
  it('does not snap outside range', () => {
    const lines = buildAlignLines([], vp, { toCanvas: true });
    const { dx, dy, guides } = snapRange({ minX: 40, maxX: 240, minY: 40, maxY: 120 }, lines, 5);
    expect([dx, dy]).toEqual([0, 0]);
    expect(guides).toHaveLength(0);
  });
});
