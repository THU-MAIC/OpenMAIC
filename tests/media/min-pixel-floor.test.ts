import { describe, expect, it } from 'vitest';
import { applyMinPixelFloor, aspectRatioToDimensions } from '@/lib/media/image-providers';

/**
 * seedream 5.0 rejects outputs below 3,686,400 px outright (HTTP 400), while
 * the app's callers ask for 1024-wide sizes. IMAGE_MIN_PIXELS scales those up.
 */
const SEEDREAM_MIN = 3_686_400;

describe('applyMinPixelFloor', () => {
  it('leaves dimensions that already meet the floor untouched', () => {
    // Exactly on the boundary must not be scaled (2560*1440 === the floor).
    expect(applyMinPixelFloor(2560, 1440, SEEDREAM_MIN)).toEqual({ width: 2560, height: 1440 });
    expect(applyMinPixelFloor(2560, 1600, SEEDREAM_MIN)).toEqual({ width: 2560, height: 1600 });
  });

  it('scales small requests above the floor while preserving aspect ratio', () => {
    const { width, height } = applyMinPixelFloor(1024, 576, SEEDREAM_MIN);

    expect(width * height).toBeGreaterThanOrEqual(SEEDREAM_MIN);
    // 16:9 in, 16:9 out (allow a little slack from the round-up to /8).
    expect(width / height).toBeCloseTo(1024 / 576, 1);
  });

  it('keeps every real caller size above the floor after rounding', () => {
    // The ratios the app actually requests, via aspectRatioToDimensions.
    for (const ratio of ['16:9', '4:3', '1:1', '3:4', '9:16']) {
      const { width, height } = aspectRatioToDimensions(ratio);
      const scaled = applyMinPixelFloor(width, height, SEEDREAM_MIN);

      expect(scaled.width * scaled.height).toBeGreaterThanOrEqual(SEEDREAM_MIN);
      // Rounded up to a multiple of 8 on both edges.
      expect(scaled.width % 8).toBe(0);
      expect(scaled.height % 8).toBe(0);
    }
  });

  it('is a no-op when no floor is configured', () => {
    // IMAGE_MIN_PIXELS unset/0 must not change historical behaviour.
    expect(applyMinPixelFloor(1024, 576, 0)).toEqual({ width: 1024, height: 576 });
    expect(applyMinPixelFloor(1024, 576, Number.NaN)).toEqual({ width: 1024, height: 576 });
  });

  it('does not divide by zero on degenerate dimensions', () => {
    expect(applyMinPixelFloor(0, 576, SEEDREAM_MIN)).toEqual({ width: 0, height: 576 });
    expect(applyMinPixelFloor(1024, 0, SEEDREAM_MIN)).toEqual({ width: 1024, height: 0 });
  });
});
