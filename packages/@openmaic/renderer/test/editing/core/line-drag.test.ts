import { describe, it, expect } from 'vitest';
import type { PPTLineElement } from '@openmaic/dsl';
import { computeLineDrag } from '../../../src/editing/core/line-drag';

const line = (o: Partial<PPTLineElement> = {}): PPTLineElement =>
  ({
    id: 'l',
    type: 'line',
    left: 100,
    top: 100,
    start: [0, 0],
    end: [50, 50],
    style: 'solid',
    color: '#333333',
    points: ['', ''],
    ...o,
  }) as PPTLineElement;

describe('computeLineDrag', () => {
  it('drags the end handle with no snap and re-normalizes the bbox', () => {
    // abs: start(100,100) end(150,150); end += (30,-10) -> (180,140)
    // bbox minX=100 minY=100 maxX=180 maxY=140 -> width 80 height 40
    const r = computeLineDrag({
      element: line(),
      handle: 'end',
      deltaCanvas: { x: 30, y: -10 },
    });
    expect(r.props).toEqual({ left: 100, top: 100, start: [0, 0], end: [80, 40] });
    // straight line carries no control field
    expect('curve' in r.props).toBe(false);
    expect('broken' in r.props).toBe(false);
    expect('cubic' in r.props).toBe(false);
  });

  it('snaps the dragged start handle onto the end X to straighten a near-vertical line', () => {
    // line left=200 top=50 start[0,0] end[4,80]; abs start(200,50) end(204,130)
    // drag start by (2,0) -> startX 202; |202-204|=2 < 8 -> startX = 204
    const r = computeLineDrag({
      element: line({ left: 200, top: 50, start: [0, 0], end: [4, 80] }),
      handle: 'start',
      deltaCanvas: { x: 2, y: 0 },
    });
    expect(r.props).toEqual({ left: 204, top: 50, start: [0, 0], end: [0, 80] });
  });

  it('flips start/end when the dragged start crosses past the end', () => {
    // horizontal line left=100 top=100 start[0,0] end[50,0]; abs start(100,100) end(150,100)
    // drag start by (100,0) -> startX 200 (> endX 150)
    const r = computeLineDrag({
      element: line({ start: [0, 0], end: [50, 0] }),
      handle: 'start',
      deltaCanvas: { x: 100, y: 0 },
    });
    // bbox minX=150 maxX=200; startX>endX -> start[0]=width, end[0]=0
    expect(r.props).toEqual({ left: 150, top: 100, start: [50, 0], end: [0, 0] });
  });

  it('drags a curve control handle and snaps to the segment midpoint', () => {
    // left=100 top=100 start[0,0] end[100,0] curve[50,20]
    // abs mid(150,120); drag by (0,-15) -> (150,105); y snaps to endY/startY 100,
    // then segment-midpoint snap (150,100) -> curve local [50,0]
    const r = computeLineDrag({
      element: line({ start: [0, 0], end: [100, 0], curve: [50, 20] }),
      handle: 'ctrl',
      deltaCanvas: { x: 0, y: -15 },
    });
    expect(r.props).toEqual({
      left: 100,
      top: 100,
      start: [0, 0],
      end: [100, 0],
      curve: [50, 0],
    });
  });

  it('updates curve local coords for a non-snapping ctrl drag on a diagonal line', () => {
    // left=100 top=100 start[0,0] end[100,60] curve[40,10]; abs mid(140,110)
    // drag by (5,5) -> (145,115); no snap -> local [45,15]
    const r = computeLineDrag({
      element: line({ start: [0, 0], end: [100, 60], curve: [40, 10] }),
      handle: 'ctrl',
      deltaCanvas: { x: 5, y: 5 },
    });
    expect(r.props).toEqual({
      left: 100,
      top: 100,
      start: [0, 0],
      end: [100, 60],
      curve: [45, 15],
    });
  });

  it('resets the curve control to the new local midpoint when an endpoint is dragged', () => {
    // left=100 top=100 start[0,0] end[100,0] curve[50,40]
    // drag start by (30,-10) -> abs start(130,90) end(200,100)
    // bbox minX=130 minY=90 -> width 70 height 10; curve reset to midpoint [35,5]
    const r = computeLineDrag({
      element: line({ start: [0, 0], end: [100, 0], curve: [50, 40] }),
      handle: 'start',
      deltaCanvas: { x: 30, y: -10 },
    });
    expect(r.props).toEqual({
      left: 130,
      top: 90,
      start: [0, 0],
      end: [70, 10],
      curve: [35, 5],
    });
  });

  it('updates cubic[0] when the first cubic control handle is dragged', () => {
    // left=100 top=100 start[0,0] end[100,0] cubic[[30,20],[70,-20]]
    // abs c1(130,120); drag by (10,-5) -> (140,115); no snap -> local [40,15]
    const r = computeLineDrag({
      element: line({
        start: [0, 0],
        end: [100, 0],
        cubic: [
          [30, 20],
          [70, -20],
        ],
      }),
      handle: 'ctrl1',
      deltaCanvas: { x: 10, y: -5 },
    });
    expect(r.props).toEqual({
      left: 100,
      top: 100,
      start: [0, 0],
      end: [100, 0],
      cubic: [
        [40, 15],
        [70, -20],
      ],
    });
  });
});
