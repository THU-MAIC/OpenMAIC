import { describe, expect, it } from 'vitest';

import { getElementRange } from '@/lib/utils/element';
import type { PPTLineElement } from '@/lib/types/slides';

// Minimal line factory — getElementRange only reads
// type/left/top/start/end/broken/broken2/curve/cubic.
const line = (overrides: Partial<PPTLineElement>): PPTLineElement =>
  ({
    id: 'l1',
    type: 'line',
    left: 100,
    top: 100,
    width: 0,
    start: [0, 0],
    end: [50, 0],
    style: 'solid',
    color: '#000000',
    points: ['', ''],
    ...overrides,
  }) as unknown as PPTLineElement;

describe('getElementRange — line elements', () => {
  it('is unchanged for a plain endpoint-only line', () => {
    expect(getElementRange(line({ start: [0, 0], end: [50, 30] }))).toEqual({
      minX: 100,
      maxX: 150,
      minY: 100,
      maxY: 130,
    });
  });

  it('uses the min of the endpoints, not just `left`', () => {
    // Neither endpoint sits at offset 0, so the left/top edges are inset.
    expect(getElementRange(line({ start: [10, 5], end: [40, 25] }))).toEqual({
      minX: 110,
      maxX: 140,
      minY: 105,
      maxY: 125,
    });
  });

  it('expands the box to include a quadratic curve control point', () => {
    const r = getElementRange(line({ start: [0, 0], end: [40, 0], curve: [20, 60] }));
    expect(r.maxY).toBe(160); // 100 + 60 — was 100 (clipped) before the fix
    expect(r.maxX).toBe(140);
  });

  it('includes broken / elbow control points', () => {
    const r = getElementRange(line({ start: [0, 0], end: [40, 40], broken: [80, 10] }));
    expect(r.maxX).toBe(180); // 100 + 80 — was 140 before the fix
  });

  it('includes both cubic bezier control points (incl. negative offsets)', () => {
    const r = getElementRange(
      line({
        start: [0, 0],
        end: [40, 0],
        cubic: [
          [-10, 20],
          [50, -30],
        ],
      }),
    );
    expect(r).toEqual({ minX: 90, maxX: 150, minY: 70, maxY: 120 });
  });
});
