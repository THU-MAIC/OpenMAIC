import { describe, expect, it } from 'vitest';
import { fitGenUiViewport } from '@/lib/interactive/logical-viewport';

describe('responsive GenUI viewport', () => {
  it('gives the iframe the learner slot without scaling its CSS pixels', () => {
    expect(fitGenUiViewport({ left: 20, top: 30, width: 1280, height: 720 })).toEqual({
      scale: 1,
      box: { left: 20, top: 30, width: 1280, height: 720 },
    });
  });

  it('preserves a narrow learner slot so responsive CSS and minimum type remain effective', () => {
    expect(fitGenUiViewport({ left: 10, top: 20, width: 640, height: 500 })).toEqual({
      scale: 1,
      box: { left: 10, top: 20, width: 640, height: 500 },
    });
  });

  it('preserves a tall mobile learner slot without letterboxing', () => {
    expect(fitGenUiViewport({ left: 0, top: 0, width: 1600, height: 1200 })).toEqual({
      scale: 1,
      box: { left: 0, top: 0, width: 1600, height: 1200 },
    });
  });

  it('collapses safely before the slot has a measurable size', () => {
    expect(fitGenUiViewport({ left: 7, top: 9, width: 0, height: 400 })).toEqual({
      scale: 1,
      box: { left: 7, top: 9, width: 0, height: 400 },
    });
  });
});
