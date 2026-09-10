import { describe, expect, it } from 'vitest';
import {
  GENUI_LOGICAL_HEIGHT,
  GENUI_LOGICAL_WIDTH,
  fitGenUiViewport,
} from '@/lib/interactive/logical-viewport';

describe('fixed GenUI logical viewport', () => {
  it('fills a matching 16:9 slot without changing the iframe viewport', () => {
    expect(fitGenUiViewport({ left: 20, top: 30, width: 1280, height: 720 })).toEqual({
      scale: 1,
      box: { left: 20, top: 30, width: 1280, height: 720 },
    });
    expect([GENUI_LOGICAL_WIDTH, GENUI_LOGICAL_HEIGHT]).toEqual([1280, 720]);
  });

  it('centers a scaled-down viewport in a narrow editor pane', () => {
    expect(fitGenUiViewport({ left: 10, top: 20, width: 640, height: 500 })).toEqual({
      scale: 0.5,
      box: { left: 10, top: 90, width: 640, height: 360 },
    });
  });

  it('centers horizontally in a tall slot and scales up consistently', () => {
    expect(fitGenUiViewport({ left: 0, top: 0, width: 1600, height: 1200 })).toEqual({
      scale: 1.25,
      box: { left: 0, top: 150, width: 1600, height: 900 },
    });
  });

  it('collapses safely before the slot has a measurable size', () => {
    expect(fitGenUiViewport({ left: 7, top: 9, width: 0, height: 400 })).toEqual({
      scale: 0,
      box: { left: 7, top: 209, width: 0, height: 0 },
    });
  });
});
