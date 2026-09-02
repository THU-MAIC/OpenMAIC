/**
 * Server-side sizing of an image generation request.
 *
 * Two steps that every server-issued image request needs, in this order:
 *
 * 1. **aspect ratio → pixels**, when the caller only expressed a ratio.
 * 2. **minimum-area floor** (`IMAGE_MIN_PIXELS`), scaling the request up while
 *    preserving the ratio. Some models reject outputs below a minimum area —
 *    seedream 5.0 requires >= 3,686,400 px and returns HTTP 400 otherwise, so
 *    the 1024-wide sizes callers ask for would always fail. Unset (the
 *    default) changes nothing.
 *
 * This lives here rather than in `lib/media/image-providers.ts` because it reads
 * `process.env`; the pure geometry it builds on (`applyMinPixelFloor`,
 * `aspectRatioToDimensions`) stays in that browser-bundled module.
 *
 * Both server paths that generate images must call this — `/api/generate/image`
 * and the classroom generator. The classroom path skipping it is what made
 * seedream reject every server-side course illustration for being too small.
 */
import { applyMinPixelFloor, aspectRatioToDimensions } from '@/lib/media/image-providers';
import { createLogger } from '@/lib/logger';
import type { ImageGenerationOptions } from '@/lib/media/types';

const log = createLogger('ImageSizing');

/** Edge the adapters fall back to when a request carries no explicit size. */
export const DEFAULT_IMAGE_EDGE = 1024;

/**
 * Return a copy of `options` with `width`/`height` resolved and raised to the
 * configured minimum area. Never mutates the input.
 */
export function resolveImageSize<T extends ImageGenerationOptions>(options: T): T {
  const resolved = { ...options };

  if (!resolved.width && !resolved.height && resolved.aspectRatio) {
    const dims = aspectRatioToDimensions(resolved.aspectRatio);
    resolved.width = dims.width;
    resolved.height = dims.height;
  }

  const minPixels = Number(process.env.IMAGE_MIN_PIXELS || 0);
  if (minPixels > 0) {
    const width = resolved.width || DEFAULT_IMAGE_EDGE;
    const height = resolved.height || DEFAULT_IMAGE_EDGE;
    const scaled = applyMinPixelFloor(width, height, minPixels);
    if (scaled.width !== width || scaled.height !== height) {
      resolved.width = scaled.width;
      resolved.height = scaled.height;
      log.info(
        `Image size ${width}x${height} below IMAGE_MIN_PIXELS=${minPixels}; ` +
          `scaled to ${resolved.width}x${resolved.height}`,
      );
    }
  }

  return resolved;
}
