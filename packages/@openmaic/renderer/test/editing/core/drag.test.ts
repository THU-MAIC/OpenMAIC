import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { computeDragMove } from '../../../src/editing/core/drag';
import { moveIntent } from '../../../src/editing/core/intent';

const el = (o: Partial<PPTElement> = {}) =>
  ({
    id: 'a',
    type: 'text',
    left: 100,
    top: 100,
    width: 200,
    height: 80,
    rotate: 0,
    ...o,
  }) as unknown as PPTElement;
const vp = { width: 1000, height: 562 };

describe('computeDragMove', () => {
  it('moves by the delta when nothing to snap', () => {
    const r = computeDragMove({
      element: el(),
      others: [],
      viewport: vp,
      deltaCanvas: { x: 30, y: -10 },
      snapping: false,
    });
    expect(r.props).toEqual({ left: 130, top: 90 });
    expect(r.guides).toHaveLength(0);
  });
  it('axis lock y ignores x delta', () => {
    const r = computeDragMove({
      element: el(),
      others: [],
      viewport: vp,
      deltaCanvas: { x: 30, y: -10 },
      axisLock: 'y',
      snapping: false,
    });
    expect(r.props).toEqual({ left: 100, top: 90 });
  });
  it('returns a line element unchanged (lines are not box-model draggable)', () => {
    const line = {
      id: 'l',
      type: 'line',
      left: 10,
      top: 20,
      start: [0, 0],
      end: [50, 50],
      width: 2,
      style: 'solid',
      color: '#333',
      points: ['', ''],
    } as unknown as PPTElement;
    const r = computeDragMove({
      element: line,
      others: [],
      viewport: vp,
      deltaCanvas: { x: 30, y: -10 },
      snapping: { toCanvas: true, range: 5 },
    });
    expect(r.props).toEqual({ left: 10, top: 20 });
    expect(r.guides).toHaveLength(0);
  });
  it('snaps the left edge to the canvas edge and emits a guide', () => {
    // drag so left edge lands at x=2 → snap to 0
    const r = computeDragMove({
      element: el({ left: 0 }),
      others: [],
      viewport: vp,
      deltaCanvas: { x: 2, y: 0 },
      snapping: { toCanvas: true, range: 5 },
    });
    expect(r.props.left).toBe(0);
    expect(r.guides.some((g) => g.type === 'vertical' && g.axis.x === 0)).toBe(true);
  });
});

describe('moveIntent', () => {
  it('produces an element.update intent', () => {
    expect(moveIntent('a', { left: 130, top: 90 })).toEqual({
      type: 'element.update',
      id: 'a',
      props: { left: 130, top: 90 },
    });
  });
});
