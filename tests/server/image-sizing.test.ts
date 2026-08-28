import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveImageSize } from '@/lib/server/image-sizing';
import type { ImageGenerationOptions } from '@/lib/media/types';

const originalMinPixels = process.env.IMAGE_MIN_PIXELS;

function options(overrides: Partial<ImageGenerationOptions> = {}): ImageGenerationOptions {
  return { prompt: 'a prompt', ...overrides };
}

describe('resolveImageSize', () => {
  beforeEach(() => {
    delete process.env.IMAGE_MIN_PIXELS;
  });

  afterEach(() => {
    if (originalMinPixels === undefined) {
      delete process.env.IMAGE_MIN_PIXELS;
    } else {
      process.env.IMAGE_MIN_PIXELS = originalMinPixels;
    }
  });

  it('resolves an aspect ratio to pixels when no explicit size is given', () => {
    const result = resolveImageSize(options({ aspectRatio: '16:9' }));
    expect(result.width).toBe(1024);
    expect(result.height).toBe(576);
  });

  it('leaves explicit width/height untouched (ratio ignored)', () => {
    const result = resolveImageSize(options({ width: 512, height: 768, aspectRatio: '16:9' }));
    expect(result).toMatchObject({ width: 512, height: 768 });
  });

  it('is a no-op when no minimum area is configured', () => {
    const input = options({ width: 1024, height: 576 });
    expect(resolveImageSize(input)).toMatchObject({ width: 1024, height: 576 });
  });

  it('scales a request up to the configured minimum area, preserving the ratio', () => {
    process.env.IMAGE_MIN_PIXELS = '3686400'; // seedream 5.0 floor
    const result = resolveImageSize(options({ width: 1024, height: 576 }));
    expect(result.width! * result.height!).toBeGreaterThanOrEqual(3_686_400);
    expect(result.width! / result.height!).toBeCloseTo(1024 / 576, 1);
    expect(result.width! % 8).toBe(0);
    expect(result.height! % 8).toBe(0);
  });

  it('never mutates the input options object', () => {
    const input = options({ aspectRatio: '4:3' });
    resolveImageSize(input);
    expect(input).toMatchObject({ prompt: 'a prompt', aspectRatio: '4:3' });
    expect(input.width).toBeUndefined();
    expect(input.height).toBeUndefined();
  });

  it('falls back to the default edge only inside the minimum-area branch', () => {
    // No explicit size: the floor computation starts from the default 1024
    // edge and scales it up (1024x1024 -> 1920x1920 hits the seedream floor).
    process.env.IMAGE_MIN_PIXELS = '3686400';
    expect(resolveImageSize(options({}))).toMatchObject({ width: 1920, height: 1920 });
  });
});
