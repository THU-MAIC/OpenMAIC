import { afterEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '@/lib/store/canvas';
import { isActiveCanvasScene, syncCanvasViewportFromSlide } from '@/lib/store/sync-canvas-viewport';

const original = {
  viewportSize: useCanvasStore.getState().viewportSize,
  viewportRatio: useCanvasStore.getState().viewportRatio,
};

afterEach(() => {
  useCanvasStore.getState().setViewportSize(original.viewportSize);
  useCanvasStore.getState().setViewportRatio(original.viewportRatio);
});

describe('syncCanvasViewportFromSlide', () => {
  it('copies the slide viewport into the canvas store', () => {
    expect(syncCanvasViewportFromSlide({ viewportSize: 1280, viewportRatio: 0.5625 })).toBe(true);
    expect(useCanvasStore.getState().viewportSize).toBe(1280);
    expect(useCanvasStore.getState().viewportRatio).toBe(0.5625);
  });

  it('is a no-op when the store already matches', () => {
    useCanvasStore.getState().setViewportSize(1280);
    useCanvasStore.getState().setViewportRatio(0.5625);
    expect(syncCanvasViewportFromSlide({ viewportSize: 1280, viewportRatio: 0.5625 })).toBe(false);
  });

  it('falls back to 1000×16:9 when the slide has no viewport metadata', () => {
    useCanvasStore.getState().setViewportSize(1280);
    useCanvasStore.getState().setViewportRatio(0.75);
    expect(syncCanvasViewportFromSlide({})).toBe(true);
    expect(useCanvasStore.getState().viewportSize).toBe(1000);
    expect(useCanvasStore.getState().viewportRatio).toBe(0.5625);
  });

  it('does not write the store for a keep-alive scene that is not current', () => {
    expect(isActiveCanvasScene('scene-a', 'scene-b')).toBe(false);
    expect(isActiveCanvasScene('scene-a', 'scene-a')).toBe(true);
    expect(isActiveCanvasScene('scene-a', undefined)).toBe(true);
  });
});
