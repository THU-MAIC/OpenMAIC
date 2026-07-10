import { describe, it, expect } from 'vitest';
import type { PPTElement, PPTTextElement, PPTImageElement, PPTShapeElement } from '@openmaic/dsl';
import {
  computeResize,
  getResizeHandles,
  getResizeCursor,
  getRotateElementPoints,
  RESIZE_HANDLES,
} from '../../../src/editing/core/resize';

const text = (o: Partial<PPTTextElement> = {}): PPTTextElement =>
  ({
    id: 'a',
    type: 'text',
    left: 100,
    top: 100,
    width: 200,
    height: 80,
    rotate: 0,
    content: 'x',
    defaultFontName: 'a',
    defaultColor: '#000',
    lineHeight: 1,
    ...o,
  }) as PPTTextElement;

const image = (o: Partial<PPTImageElement> = {}): PPTImageElement =>
  ({
    id: 'i',
    type: 'image',
    left: 100,
    top: 100,
    width: 200,
    height: 80,
    rotate: 0,
    fixedRatio: false,
    src: 'x.png',
    ...o,
  }) as PPTImageElement;

const shape = (o: Partial<PPTShapeElement> = {}): PPTShapeElement =>
  ({
    id: 's',
    type: 'shape',
    left: 400,
    top: 300,
    width: 100,
    height: 50,
    rotate: 0,
    fixedRatio: false,
    viewBox: [100, 50],
    path: 'M 0 0 L 100 0 L 100 50 L 0 50 Z',
    fill: '#ccc',
    ...o,
  }) as PPTShapeElement;

const viewport = { width: 1000, height: 562.5 };
const noOthers: PPTElement[] = [];

describe('computeResize — un-rotated', () => {
  it('grows width/height from the right-bottom corner without moving left/top', () => {
    const r = computeResize({
      element: text(),
      handle: 'right-bottom',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 30, y: 20 },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 230, height: 100 });
    expect(r.guides).toEqual([]);
  });

  it('shrinks from the left-top corner and shifts left/top so the opposite corner stays put', () => {
    const r = computeResize({
      element: text(),
      handle: 'left-top',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 10, y: 5 },
    });
    // width 200-10=190, height 80-5=75; left/top shift by the size change.
    expect(r.props).toEqual({ left: 110, top: 105, width: 190, height: 75 });
  });

  it('an edge handle only affects its own axis (left edge ignores the y delta)', () => {
    const r = computeResize({
      element: text(),
      handle: 'left',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 30, y: 999 },
    });
    expect(r.props).toEqual({ left: 130, top: 100, width: 170, height: 80 });
  });

  it('clamps to the per-type minimum size (text: 40) and keeps the anchored edge fixed', () => {
    // Dragging the LEFT edge far right: width clamps at 40, and left shifts by
    // the (clamped) size change so the RIGHT edge stays at 300.
    const r = computeResize({
      element: text(),
      handle: 'left',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 300, y: 0 },
    });
    expect(r.props).toEqual({ left: 260, top: 100, width: 40, height: 80 });
  });

  it("locks the aspect ratio from the element's own fixedRatio on a corner", () => {
    // aspectRatio 200/80 = 2.5; moveY = moveX / 2.5 = 40.
    const r = computeResize({
      element: image({ fixedRatio: true }),
      handle: 'right-bottom',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 100, y: 0 },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 300, height: 120 });
  });

  it('locks the aspect ratio from the modifier on a corner (left-bottom sign flip)', () => {
    // lb: moveY = -moveX / ratio = -(-50)/2.5 = 20.
    const r = computeResize({
      element: text(),
      handle: 'left-bottom',
      others: noOthers,
      viewport,
      deltaCanvas: { x: -50, y: 0 },
      aspectModifier: true,
    });
    expect(r.props).toEqual({ left: 50, top: 100, width: 250, height: 100 });
  });

  it('edge handles ignore the aspect lock entirely', () => {
    const r = computeResize({
      element: image({ fixedRatio: true }),
      handle: 'right',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 50, y: 0 },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 250, height: 80 });
  });

  it('scales the min-size limits under aspect lock so both axes bottom out together', () => {
    // image min 20, ratio 2.5 > 1 → minWidth = 50, minHeight = 20.
    const r = computeResize({
      element: image({ fixedRatio: true }),
      handle: 'right-bottom',
      others: noOthers,
      viewport,
      deltaCanvas: { x: -400, y: 0 },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 50, height: 20 });
  });

  it('snaps the moving edge to a sibling edge before clamping', () => {
    // Element right edge starts at 300; delta 97 puts it at 397, within range
    // 5 of the sibling's left edge (400) → snapped to exactly 400.
    const r = computeResize({
      element: text(),
      handle: 'right-bottom',
      others: [shape()],
      viewport,
      deltaCanvas: { x: 97, y: 0 },
      snapping: { toElements: true },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 300, height: 80 });
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0].type).toBe('vertical');
  });

  it('recomputes the aspect-locked axis from the snapped axis (y snap drives x)', () => {
    // rb, aspect locked (ratio 2.5): delta x=10 → moveY = 4 → moving corner y
    // probe = 184, within 5 of the sibling's top edge (183) → dy = -1 →
    // moveY = 3, then moveX re-derived = 3 * 2.5 = 7.5.
    const r = computeResize({
      element: image({ fixedRatio: true }),
      handle: 'right-bottom',
      others: [shape({ top: 183, height: 40 })],
      viewport,
      deltaCanvas: { x: 10, y: 0 },
      snapping: { toElements: true },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 207.5, height: 83 });
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0].type).toBe('horizontal');
  });

  it('excludes rotated siblings and lines from the snap candidates', () => {
    // Same setup as the sibling-edge snap above, but the sibling is rotated —
    // its axis-aligned bbox must NOT act as a snap line, so no snap occurs.
    const r = computeResize({
      element: text(),
      handle: 'right-bottom',
      others: [shape({ rotate: 30 })],
      viewport,
      deltaCanvas: { x: 97, y: 0 },
      snapping: { toElements: true },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 297, height: 80 });
    expect(r.guides).toEqual([]);
  });

  it('snaps to the canvas edges/centers when toCanvas is enabled', () => {
    // Right edge probe = 300 + 197 = 497, within 5 of the canvas centerX (500).
    const r = computeResize({
      element: text(),
      handle: 'right',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 197, y: 0 },
      snapping: { toCanvas: true },
    });
    expect(r.props).toEqual({ left: 100, top: 100, width: 400, height: 80 });
  });
});

describe('computeResize — rotated', () => {
  it('rotates the pointer delta into local axes and keeps the opposite corner fixed', () => {
    // rotate 90: revisedX = sin(90)*dy = 30, revisedY = 0 → width 130.
    // Opposite-point correction: the rotated left-top of the origin box sits at
    // (175, 75); after the naive resize it lands at (190, 60), so left/top
    // shift back by (15, -15).
    const r = computeResize({
      element: text({ left: 100, top: 100, width: 100, height: 50, rotate: 90 }),
      handle: 'right-bottom',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 0, y: 30 },
    });
    expect(r.props.left).toBeCloseTo(85, 5);
    expect(r.props.top).toBeCloseTo(115, 5);
    expect(r.props.width).toBeCloseTo(130, 5);
    expect(r.props.height).toBeCloseTo(50, 5);
  });

  it('resizes an edge of a 180-rotated element (bottom handle tracks the on-screen top)', () => {
    // rotate 180: revisedY = -dy = 20 → height 100; the opposite (top) point
    // correction shifts top from 100 to 80 so the rotated top point stays put.
    const r = computeResize({
      element: text({ rotate: 180 }),
      handle: 'bottom',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 0, y: -20 },
    });
    expect(r.props.left).toBeCloseTo(100, 5);
    expect(r.props.top).toBeCloseTo(80, 5);
    expect(r.props.width).toBeCloseTo(200, 5);
    expect(r.props.height).toBeCloseTo(100, 5);
  });

  it('never snaps a rotated element, even when snapping is enabled', () => {
    const r = computeResize({
      element: text({ left: 100, top: 100, width: 100, height: 50, rotate: 90 }),
      handle: 'right-bottom',
      others: [shape()],
      viewport,
      deltaCanvas: { x: 0, y: 30 },
      snapping: true,
    });
    expect(r.props.width).toBeCloseTo(130, 5);
    expect(r.guides).toEqual([]);
  });

  it('applies the aspect lock in local axes on a rotated corner', () => {
    // rotate 90, rb, delta (0, 25): revisedX = 25, locked revisedY = 25 / 2
    // (ratio 100/50) = 12.5 → width 125, height 62.5.
    const r = computeResize({
      element: text({ left: 100, top: 100, width: 100, height: 50, rotate: 90 }),
      handle: 'right-bottom',
      others: noOthers,
      viewport,
      deltaCanvas: { x: 0, y: 25 },
      aspectModifier: true,
    });
    expect(r.props.width).toBeCloseTo(125, 5);
    expect(r.props.height).toBeCloseTo(62.5, 5);
  });
});

describe('getRotateElementPoints', () => {
  it('degenerates to the plain frame points at rotation 0', () => {
    const p = getRotateElementPoints({ left: 100, top: 100, width: 200, height: 80 }, 0);
    expect(p['left-top'].left).toBeCloseTo(100, 5);
    expect(p['left-top'].top).toBeCloseTo(100, 5);
    expect(p.top.left).toBeCloseTo(200, 5);
    expect(p.top.top).toBeCloseTo(100, 5);
    expect(p.right.left).toBeCloseTo(300, 5);
    expect(p.right.top).toBeCloseTo(140, 5);
    expect(p['right-bottom'].left).toBeCloseTo(300, 5);
    expect(p['right-bottom'].top).toBeCloseTo(180, 5);
    expect(p.bottom.left).toBeCloseTo(200, 5);
    expect(p.bottom.top).toBeCloseTo(180, 5);
  });

  it('rotates every point about the center (90-degree check)', () => {
    // Center (150, 125); left-top (100, 100) → rel (-50, -25) → rotated 90°
    // clockwise → (25, -50) → (175, 75).
    const p = getRotateElementPoints({ left: 100, top: 100, width: 100, height: 50 }, 90);
    expect(p['left-top'].left).toBeCloseTo(175, 5);
    expect(p['left-top'].top).toBeCloseTo(75, 5);
    expect(p['right-bottom'].left).toBeCloseTo(125, 5);
    expect(p['right-bottom'].top).toBeCloseTo(175, 5);
    expect(p.top.left).toBeCloseTo(175, 5);
    expect(p.top.top).toBeCloseTo(125, 5);
  });
});

describe('getResizeHandles — per-kind gates', () => {
  it('code elements expose no handles', () => {
    expect(
      getResizeHandles({
        id: 'c',
        type: 'code',
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        rotate: 0,
      } as never),
    ).toEqual([]);
  });

  it('horizontal text exposes only left/right', () => {
    expect(getResizeHandles(text())).toEqual(['left', 'right']);
  });

  it('vertical text exposes only top/bottom', () => {
    expect(getResizeHandles(text({ vertical: true }))).toEqual(['top', 'bottom']);
  });

  it('other box kinds expose all eight handles', () => {
    expect(getResizeHandles(image())).toEqual(RESIZE_HANDLES);
    expect(getResizeHandles(shape())).toEqual(RESIZE_HANDLES);
  });
});

describe('getResizeCursor — rotation-aware buckets', () => {
  it('matches the directional table at rotation 0', () => {
    expect(getResizeCursor('left-top', 0)).toBe('nwse-resize');
    expect(getResizeCursor('right-bottom', 0)).toBe('nwse-resize');
    expect(getResizeCursor('top', 0)).toBe('ns-resize');
    expect(getResizeCursor('left-bottom', 0)).toBe('nesw-resize');
    expect(getResizeCursor('right', 0)).toBe('ew-resize');
  });

  it('advances one direction per 45-degree bucket', () => {
    expect(getResizeCursor('left-top', 45)).toBe('ns-resize');
    expect(getResizeCursor('left', 45)).toBe('nwse-resize');
    expect(getResizeCursor('top', 90)).toBe('ew-resize');
    expect(getResizeCursor('right-bottom', 135)).toBe('ew-resize');
  });

  it('wraps negative rotations and the ±180 seam back onto the same buckets', () => {
    expect(getResizeCursor('right-bottom', -100)).toBe('nesw-resize'); // bucket 90
    expect(getResizeCursor('left', -30)).toBe('nesw-resize'); // bucket 135
    expect(getResizeCursor('bottom', 170)).toBe('ns-resize'); // bucket 0
    expect(getResizeCursor('bottom', -170)).toBe('ns-resize'); // bucket 0
  });
});
