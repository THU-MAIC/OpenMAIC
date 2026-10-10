/**
 * GLM (Zhipu BigModel) Image Generation Adapter
 *
 * Zhipu exposes an OpenAI-compatible Images API:
 * Endpoint: https://open.bigmodel.cn/api/paas/v4/images/generations
 *
 * CogView models accept a fixed set of `size` values; requested dimensions are
 * snapped to the closest supported resolution before sending.
 */

import type {
  ImageGenerationConfig,
  ImageGenerationOptions,
  ImageGenerationResult,
} from '../types';
import { mediaFetchFor } from '../media-fetch';
import { probeAuth } from '../probe-auth';
import { assertNotRedirected } from '../redirect-guard';
import { requireModel } from '../require-model';

export const DEFAULT_GLM_IMAGE_MODEL = 'cogview-3-flash';
export const DEFAULT_GLM_IMAGE_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/** CogView-supported resolutions (width x height), per BigModel docs. */
export const COGVIEW_SUPPORTED_SIZES: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1024, height: 1024 },
  { width: 768, height: 1344 },
  { width: 864, height: 1152 },
  { width: 1344, height: 768 },
  { width: 1152, height: 864 },
  { width: 1440, height: 720 },
  { width: 720, height: 1440 },
];

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || DEFAULT_GLM_IMAGE_BASE_URL).replace(/\/$/, '');
}

/** Snap requested dimensions to the CogView size with the closest aspect ratio. */
export function resolveCogViewSize(options: ImageGenerationOptions): string {
  const width = options.width || 1024;
  const height = options.height || 1024;
  const target = width / height;
  let best = COGVIEW_SUPPORTED_SIZES[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const size of COGVIEW_SUPPORTED_SIZES) {
    const delta = Math.abs(size.width / size.height - target);
    if (delta < bestDelta) {
      best = size;
      bestDelta = delta;
    }
  }
  return `${best.width}x${best.height}`;
}

export async function testGlmImageConnectivity(
  config: ImageGenerationConfig,
): Promise<{ success: boolean; message: string }> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchImpl = mediaFetchFor(config);
  return probeAuth({
    providerName: 'GLM Image',
    request: () =>
      fetchImpl(`${baseUrl}/images/generations`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model || DEFAULT_GLM_IMAGE_MODEL,
          prompt: '',
          n: 1,
        }),
      }),
  });
}

export async function generateWithGlmImage(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const model = requireModel(config.model, 'GLM Image');
  const size = resolveCogViewSize(options);
  const [width, height] = size.split('x').map(Number);

  const response = await mediaFetchFor(config)(`${baseUrl}/images/generations`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: options.prompt,
      n: 1,
      size,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  assertNotRedirected(response, 'GLM Image');

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`GLM image generation failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };

  const imageData = data.data?.[0];
  if (!imageData?.url && !imageData?.b64_json) {
    throw new Error('GLM returned empty image response');
  }

  const inline = imageData.b64_json;
  const mimeType = inline ? (inline.startsWith('/9j/') ? 'image/jpeg' : 'image/png') : undefined;

  return {
    url: imageData.url ?? (inline ? `data:${mimeType};base64,${inline}` : undefined),
    base64: inline,
    mimeType,
    width,
    height,
  };
}
