import { describe, expect, it } from 'vitest';
import {
  clampDockHeight,
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
