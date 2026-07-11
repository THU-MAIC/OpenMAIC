import { describe, expect, it } from 'vitest';

import { rectsEqual, type LayoutRect } from '@/components/scene-renderers/pbl/v2/host-rect';

const base: LayoutRect = { left: 100, top: 50, width: 800, height: 450 };

describe('PBL v2 — rectsEqual (docked host-rect dirty-check)', () => {
  it('is true for identical rects (idle frame → no re-render)', () => {
    expect(rectsEqual(base, { ...base })).toBe(true);
  });

  it('detects a position-only shift (the side-panel re-center bug)', () => {
    // The 16:9 host box is height-constrained, so toggling a side panel moves
    // it horizontally without resizing it. This must be seen as a change so the
    // docked frame follows instead of leaking the box beside it.
    expect(rectsEqual(base, { ...base, left: 240 })).toBe(false);
    expect(rectsEqual(base, { ...base, top: 70 })).toBe(false);
  });

  it('detects a size change', () => {
    expect(rectsEqual(base, { ...base, width: 900 })).toBe(false);
    expect(rectsEqual(base, { ...base, height: 506 })).toBe(false);
  });
});
