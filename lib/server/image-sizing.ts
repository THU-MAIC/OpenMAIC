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
 * 3. **provider buckets**, for models that only accept a fixed size list
 *    (GPT Image 2, an SDXL ComfyUI workflow).
 *
 * This lives here rather than in `lib/media/image-providers.ts` because it reads
 * `process.env`; the pure geometry it builds on (`applyMinPixelFloor`,
 * `aspectRatioToDimensions`) stays in that browser-bundled module.
 *
 * Both server paths that generate images must call this — `/api/generate/image`
 * and the classroom generator. The classroom path skipping it is what made
 * seedream reject every server-side course illustration for being too small.
 */
import {
  applyMinPixelFloor,
  aspectRatioToDimensions,
  IMAGE_PROVIDERS,
} from '@/lib/media/image-providers';
import { createLogger } from '@/lib/logger';
import type { ImageGenerationOptions } from '@/lib/media/types';

const log = createLogger('ImageSizing');

/** Edge the adapters fall back to when a request carries no explicit size. */
export const DEFAULT_IMAGE_EDGE = 1024;

export interface ImageSizeConstraints {
  providerId?: string;
  modelId?: string;
}

const GPT_IMAGE_2_SQUARE = { width: 1024, height: 1024 };
const GPT_IMAGE_2_LANDSCAPE = { width: 1536, height: 1024 };
const GPT_IMAGE_2_PORTRAIT = { width: 1024, height: 1536 };

/**
 * Resolutions SDXL was trained on. A generic 1024×576 16:9 request is a poor
 * fit; these buckets are the ones the shipped `comfyui-workflow-sdxl.json`
 * example expects. Applied only when the selected workflow name contains
 * "sdxl", so the default Flux/Ernie workflow keeps its own sizes.
 */
const SDXL_BUCKETS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
  '9:16': { width: 768, height: 1344 },
  '4:3': { width: 1152, height: 896 },
  '3:4': { width: 896, height: 1152 },
};

function isSdxlWorkflow(modelId: string | undefined): boolean {
  return !!modelId && /sdxl/i.test(modelId);
}

function resolveSdxlSize(
  width: number,
  height: number,
  aspectRatio?: string,
): { width: number; height: number } {
  if (aspectRatio && SDXL_BUCKETS[aspectRatio]) return SDXL_BUCKETS[aspectRatio];
  const ratio = width > 0 && height > 0 ? width / height : 1;
  let best = SDXL_BUCKETS['1:1'];
  let bestDiff = Infinity;
  for (const bucket of Object.values(SDXL_BUCKETS)) {
    const diff = Math.abs(bucket.width / bucket.height - ratio);
    if (diff < bestDiff) {
      best = bucket;
      bestDiff = diff;
    }
  }
  return best;
}

function resolveGPTImage2Size(width: number, height: number) {
  if (width > height) return GPT_IMAGE_2_LANDSCAPE;
  if (height > width) return GPT_IMAGE_2_PORTRAIT;
  return GPT_IMAGE_2_SQUARE;
}

/**
 * Return a copy of `options` with `width`/`height` resolved and raised to the
 * configured minimum area. Never mutates the input.
 */
export function resolveImageSize<T extends ImageGenerationOptions>(
  options: T,
  constraints?: ImageSizeConstraints,
): T {
  const resolved = { ...options };
  const hadExplicitSize = Boolean(resolved.width && resolved.height);

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

  // SDXL workflows snap to the training buckets above. Other ComfyUI
  // workflows keep an explicit size; an aspect ratio alone still expands to
  // the provider maximum, which is what the adapter used to do itself and
  // what the setup guide documents (16:9 → 1920×1080).
  if (constraints?.providerId === 'comfyui-image') {
    if (isSdxlWorkflow(constraints.modelId)) {
      const requestedWidth = resolved.width || DEFAULT_IMAGE_EDGE;
      const requestedHeight = resolved.height || DEFAULT_IMAGE_EDGE;
      const normalized = resolveSdxlSize(requestedWidth, requestedHeight, resolved.aspectRatio);
      if (normalized.width !== requestedWidth || normalized.height !== requestedHeight) {
        resolved.width = normalized.width;
        resolved.height = normalized.height;
        log.info(
          `ComfyUI SDXL normalized ${requestedWidth}x${requestedHeight} ` +
            `to ${normalized.width}x${normalized.height}`,
        );
      }
    } else if (!hadExplicitSize && resolved.aspectRatio) {
      const maxResolution = IMAGE_PROVIDERS['comfyui-image']?.maxResolution;
      const maxWidth = maxResolution?.width ?? DEFAULT_IMAGE_EDGE;
      const maxHeight = maxResolution?.height ?? maxWidth;
      const expanded = aspectRatioToDimensions(resolved.aspectRatio, maxWidth);
      const scale = Math.min(1, maxWidth / expanded.width, maxHeight / expanded.height);
      resolved.width = Math.round(expanded.width * scale);
      resolved.height = Math.round(expanded.height * scale);
    }
  }

  // GPT Image 2 accepts the OpenAI Images API's canonical square, landscape,
  // and portrait dimensions. In particular, a generic 1024x576 16:9 request
  // is rejected. Keep the normalization model-scoped so providers with
  // arbitrary-size APIs retain the requested aspect ratio.
  if (
    constraints?.providerId === 'openai-image' &&
    constraints.modelId?.startsWith('gpt-image-2')
  ) {
    const requestedWidth = resolved.width || DEFAULT_IMAGE_EDGE;
    const requestedHeight = resolved.height || DEFAULT_IMAGE_EDGE;
    const normalized = resolveGPTImage2Size(requestedWidth, requestedHeight);
    if (normalized.width !== requestedWidth || normalized.height !== requestedHeight) {
      resolved.width = normalized.width;
      resolved.height = normalized.height;
      log.info(
        `GPT Image 2 normalized ${requestedWidth}x${requestedHeight} ` +
          `to ${normalized.width}x${normalized.height}`,
      );
    }
  }

  return resolved;
}
