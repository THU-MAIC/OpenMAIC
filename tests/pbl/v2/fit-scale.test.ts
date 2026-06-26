import { describe, expect, it } from 'vitest';

import { computeFitScale } from '@/components/scene-renderers/pbl/v2/fit-scale';

describe('PBL v2 — computeFitScale', () => {
  it('keeps natural size (1) when the content already fits', () => {
    expect(
      computeFitScale({
        containerWidth: 1280,
        containerHeight: 720,
        contentWidth: 640,
        contentHeight: 500,
      }),
    ).toBe(1);
  });

  it('never scales up content that is smaller than the box', () => {
    expect(
      computeFitScale({
        containerWidth: 1280,
        containerHeight: 720,
        contentWidth: 100,
        contentHeight: 100,
      }),
    ).toBe(1);
  });

  it('shrinks by the height ratio when the content is too tall (the Hero zoom bug)', () => {
    // Box shorter than the content → scale down so the bottom (launch button)
    // stays visible instead of being clipped by overflow-hidden.
    expect(
      computeFitScale({
        containerWidth: 800,
        containerHeight: 400,
        contentWidth: 640,
        contentHeight: 800,
      }),
    ).toBe(0.5);
  });

  it('shrinks by the width ratio when the content is too wide', () => {
    expect(
      computeFitScale({
        containerWidth: 320,
        containerHeight: 720,
        contentWidth: 640,
        contentHeight: 360,
      }),
    ).toBe(0.5);
  });

  it('uses the smaller ratio when both axes overflow', () => {
    // width ratio 0.5, height ratio 0.25 → must pick 0.25 so both fit.
    expect(
      computeFitScale({
        containerWidth: 320,
        containerHeight: 200,
        contentWidth: 640,
        contentHeight: 800,
      }),
    ).toBe(0.25);
  });

  it('falls back to 1 for unmeasured / degenerate dimensions', () => {
    expect(
      computeFitScale({ containerWidth: 0, containerHeight: 0, contentWidth: 0, contentHeight: 0 }),
    ).toBe(1);
    expect(
      computeFitScale({
        containerWidth: 800,
        containerHeight: 600,
        contentWidth: 0,
        contentHeight: 400,
      }),
    ).toBe(1);
    expect(
      computeFitScale({
        containerWidth: Number.NaN,
        containerHeight: 600,
        contentWidth: 400,
        contentHeight: 400,
      }),
    ).toBe(1);
  });
});
