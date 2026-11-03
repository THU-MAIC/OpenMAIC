import { describe, expect, it } from 'vitest';
import {
  clampDockHeight,
  dockBubbleBox,
  dockBubbleVars,
  DOCK_DEFAULT_HEIGHT,
  DOCK_FOLDED_HEIGHT,
  DOCK_MAX_HEIGHT,
  DOCK_MIN_CANVAS_HEIGHT,
  DOCK_MIN_HEIGHT,
} from '@/lib/edit/dock-height';

describe('clampDockHeight', () => {
  it('holds the limits', () => {
    expect(clampDockHeight(10, 900)).toBe(DOCK_MIN_HEIGHT);
    expect(clampDockHeight(9999, 2000)).toBe(DOCK_MAX_HEIGHT);
  });
  it('leaves the canvas its room in a short host', () => {
    expect(clampDockHeight(480, 500)).toBe(500 - DOCK_MIN_CANVAS_HEIGHT);
  });
  it('keeps the dock usable in a host too short for both', () => {
    expect(clampDockHeight(480, 300)).toBe(DOCK_MIN_HEIGHT);
  });
  it('takes the stored height before the host is measured', () => {
    expect(clampDockHeight(260, null)).toBe(260);
  });
});

describe('dockBubbleBox', () => {
  it('leaves the bubble hugging its text up to the default height', () => {
    expect(dockBubbleBox(DOCK_DEFAULT_HEIGHT)).toEqual({
      maxHeight: 110,
      minHeight: 0,
      width: 420,
    });
    expect(dockBubbleBox(DOCK_MIN_HEIGHT)).toEqual({ maxHeight: 68, minHeight: 0, width: 420 });
  });

  it('fills the dock at its tallest, at a width that still reads', () => {
    expect(dockBubbleBox(DOCK_MAX_HEIGHT)).toEqual({ maxHeight: 398, minHeight: 398, width: 720 });
  });

  it('grows with every pixel of a drag, with no jump and never past its limit', () => {
    let previous = dockBubbleBox(DOCK_DEFAULT_HEIGHT);
    for (let height = DOCK_DEFAULT_HEIGHT + 1; height <= DOCK_MAX_HEIGHT; height += 1) {
      const box = dockBubbleBox(height);
      expect(box.minHeight).toBeLessThanOrEqual(box.maxHeight);
      expect(box.minHeight).toBeGreaterThanOrEqual(previous.minHeight);
      expect(box.minHeight - previous.minHeight).toBeLessThan(5);
      expect(box.width - previous.width).toBeLessThan(5);
      previous = box;
    }
  });

  it('keeps a bubble that can still be seen in a folded dock', () => {
    expect(dockBubbleBox(DOCK_FOLDED_HEIGHT).maxHeight).toBe(40);
  });

  it('hands the box to the classes as custom properties', () => {
    expect(dockBubbleVars(DOCK_MAX_HEIGHT)).toEqual({
      '--dock-bubble-max': '398px',
      '--dock-bubble-min': '398px',
      '--dock-bubble-width': '720px',
    });
  });
});
