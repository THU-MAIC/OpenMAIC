import { describe, expect, it } from 'vitest';
import {
  GENUI_LOGICAL_HEIGHT,
  GENUI_LOGICAL_WIDTH,
  fitGenUiViewport,
} from '@/lib/interactive/logical-viewport';

describe('GenUI logical viewport', () => {
  it('keeps the 1280×720 minimum for an exact 16:9 slot', () => {
    expect([GENUI_LOGICAL_WIDTH, GENUI_LOGICAL_HEIGHT]).toEqual([1280, 720]);
    expect(fitGenUiViewport({ left: 20, top: 30, width: 1280, height: 720 })).toEqual({
      scale: 1,
      width: 1280,
      height: 720,
      box: { left: 20, top: 30, width: 1280, height: 720 },
    });
    expect(fitGenUiViewport({ left: 0, top: 0, width: 1920, height: 1080 })).toEqual({
      scale: 1.5,
      width: 1280,
      height: 720,
      box: { left: 0, top: 0, width: 1920, height: 1080 },
    });
  });

  it('grows the logical height to fill a slot taller than 16:9, with no bands', () => {
    const fitted = fitGenUiViewport({ left: 10, top: 20, width: 1190, height: 1025 });
    expect(fitted.scale).toBeCloseTo(1190 / 1280);
    expect(fitted.width).toBe(1280);
    expect(fitted.height).toBeCloseTo(1025 / (1190 / 1280));
    expect(fitted.height).toBeGreaterThan(720);
    expect(fitted.box).toEqual({ left: 10, top: 20, width: 1190, height: 1025 });
    expect(fitted.width * fitted.scale).toBeCloseTo(1190);
    expect(fitted.height * fitted.scale).toBeCloseTo(1025);
  });

  it('grows the logical width to fill a slot wider than 16:9', () => {
    expect(fitGenUiViewport({ left: 0, top: 0, width: 2000, height: 720 })).toEqual({
      scale: 1,
      width: 2000,
      height: 720,
      box: { left: 0, top: 0, width: 2000, height: 720 },
    });
  });

  it('never drops below the minimum when the slot is smaller than 1280×720', () => {
    const fitted = fitGenUiViewport({ left: 10, top: 20, width: 640, height: 500 });
    expect(fitted.scale).toBe(0.5);
    expect(fitted.width).toBe(1280);
    expect(fitted.height).toBe(1000);
    expect(fitted.box).toEqual({ left: 10, top: 20, width: 640, height: 500 });
    for (const slot of [
      { width: 333, height: 777 },
      { width: 1001, height: 99 },
      { width: 1191.3, height: 1024.7 },
    ]) {
      const f = fitGenUiViewport({ left: 0, top: 0, ...slot });
      expect(f.width).toBeGreaterThanOrEqual(GENUI_LOGICAL_WIDTH);
      expect(f.height).toBeGreaterThanOrEqual(GENUI_LOGICAL_HEIGHT);
      expect(Math.min(f.width - GENUI_LOGICAL_WIDTH, f.height - GENUI_LOGICAL_HEIGHT)).toBeCloseTo(
        0,
      );
    }
  });

  it('collapses safely before the slot has a measurable size', () => {
    expect(fitGenUiViewport({ left: 7, top: 9, width: 0, height: 400 })).toEqual({
      scale: 0,
      width: 1280,
      height: 720,
      box: { left: 7, top: 9, width: 0, height: 0 },
    });
  });
});
