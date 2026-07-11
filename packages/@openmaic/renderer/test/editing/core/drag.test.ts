import { describe, it, expect } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { computeDragMove, computeMultiDragMove } from '../../../src/editing/core/drag';
import { moveIntent, moveManyIntent } from '../../../src/editing/core/intent';

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

describe('moveManyIntent', () => {
  it('produces a single element.updateMany intent carrying every update', () => {
    const updates = [
      { id: 'a', props: { left: 10, top: 20 } },
      { id: 'b', props: { left: 30, top: 40 } },
    ];
    expect(moveManyIntent(updates)).toEqual({ type: 'element.updateMany', updates });
  });
});

describe('computeMultiDragMove', () => {
  const a = () => el({ id: 'a', left: 100, top: 100, width: 50, height: 50 });
  const b = () => el({ id: 'b', left: 300, top: 200, width: 50, height: 50 });

  it('translates every selected element by the same delta (rigid, no snap)', () => {
    const r = computeMultiDragMove({
      handleElement: a(),
      selected: [a(), b()],
      others: [],
      viewport: vp,
      deltaCanvas: { x: 40, y: -15 },
      snapping: false,
    });
    expect(r.updates).toEqual([
      { id: 'a', props: { left: 140, top: 85 } },
      { id: 'b', props: { left: 340, top: 185 } },
    ]);
    expect(r.guides).toHaveLength(0);
  });

  it('snaps the UNION bbox and applies the SAME correction to all (spacing preserved)', () => {
    // Union of a+b shifted by +2 lands its left edge at 102; the canvas left
    // edge (0) is out of range, but the element 'c' at left 148 provides a snap
    // line the shifted union's right edge (352) is nowhere near — use a snap
    // target that pulls the union's LEFT edge (a.left) onto c's left edge.
    const c = el({ id: 'c', left: 104, top: 500, width: 10, height: 10 });
    const r = computeMultiDragMove({
      handleElement: a(),
      selected: [a(), b()],
      others: [c],
      viewport: vp,
      deltaCanvas: { x: 2, y: 0 },
      snapping: { toElements: true, range: 5 },
    });
    // Shifted union minX = 102; snaps onto c.left 104 → +2 correction. BOTH
    // elements move by the total (2 + 2 = 4), preserving their 200-unit spacing.
    expect(r.updates[0].props.left).toBe(104);
    expect(r.updates[1].props.left).toBe(304);
    expect(r.updates[1].props.left - r.updates[0].props.left).toBe(200);
  });

  it('reduces to computeDragMove for a single selected element (parity)', () => {
    const others = [b()];
    const deltaCanvas = { x: 12, y: -7 };
    const single = computeDragMove({
      element: a(),
      others,
      viewport: vp,
      deltaCanvas,
      snapping: true,
    });
    const multi = computeMultiDragMove({
      handleElement: a(),
      selected: [a()],
      others,
      viewport: vp,
      deltaCanvas,
      snapping: true,
    });
    expect(multi.updates).toEqual([{ id: 'a', props: single.props }]);
    expect(multi.guides).toEqual(single.guides);
  });

  it('returns a do-nothing result for an empty selection (no ±Infinity ranges)', () => {
    const r = computeMultiDragMove({
      handleElement: a(),
      selected: [],
      others: [b()],
      viewport: vp,
      deltaCanvas: { x: 10, y: 5 },
      snapping: true,
    });
    expect(r).toEqual({ updates: [], guides: [] });
  });

  it('carries a selected line along by the delta (unlike lone-line single drag)', () => {
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
    const r = computeMultiDragMove({
      handleElement: a(),
      selected: [a(), line],
      others: [],
      viewport: vp,
      deltaCanvas: { x: 5, y: 5 },
      snapping: false,
    });
    // The line moves with the set (single-element computeDragMove leaves a lone
    // line put; a multi-drag translates it).
    expect(r.updates).toContainEqual({ id: 'l', props: { left: 15, top: 25 } });
  });

  it('uses a bent selected line range when snapping the multi-drag union bbox', () => {
    const curveLine = {
      id: 'curve',
      type: 'line',
      left: 300,
      top: 100,
      start: [0, 0],
      end: [100, 0],
      curve: [50, 80],
      width: 2,
      style: 'solid',
      color: '#333',
      points: ['', ''],
    } as unknown as PPTElement;
    const target = el({ id: 'target', left: 800, top: 181, width: 20, height: 20 });
    const r = computeMultiDragMove({
      handleElement: a(),
      selected: [a(), curveLine],
      others: [target],
      viewport: vp,
      deltaCanvas: { x: 0, y: 0 },
      snapping: { toElements: true, range: 5 },
    });
    expect(r.updates).toEqual([
      { id: 'a', props: { left: 100, top: 101 } },
      { id: 'curve', props: { left: 300, top: 101 } },
    ]);
    expect(r.guides.some((g) => g.type === 'horizontal' && g.axis.y === 181)).toBe(true);
  });
});
