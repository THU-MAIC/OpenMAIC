/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/generate/image
 *
 * Headers:
 *   x-image-provider: ImageProviderId (optional, server-configured default)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveServerImageProviderId,
} from '@/lib/server/provider-config';
import type {
  ImageGenerationConfig,
  ImageGenerationResult,
  ImageGenerationOptions,
  ImageProviderId,
} from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { resolveImageSize } from '@/lib/server/image-sizing';

const log = createLogger('ImageGeneration API');

/** Total attempts per request (initial call + retries). */
const IMAGE_TRANSIENT_RETRY_ATTEMPTS = 3;
/** First retry backoff; doubles per attempt. */
const IMAGE_TRANSIENT_RETRY_BASE_DELAY_MS = 400;

/** undici/Node transport-level failure codes worth a bounded retry. */
const TRANSIENT_TRANSPORT_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
];

/**
 * A dropped connection ("fetch failed" — undici's generic transport message)
 * is not retried by undici for POST bodies, so a single transient reset used
 * to fail the whole image task. Retry bounded, only for transport failures:
 * HTTP-level and content-safety rejections pass through untouched (they would
 * repeat deterministically and may bill per attempt).
 */
function isTransientTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'fetch failed' || message === 'network error') return true;
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_TRANSPORT_CODES.includes(code)) return true;
  }
  return false;
}

async function generateImageWithTransientRetry(
  config: ImageGenerationConfig,
  options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= IMAGE_TRANSIENT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await generateImage(config, options);
    } catch (error) {
      lastError = error;
      if (!isTransientTransportError(error) || attempt === IMAGE_TRANSIENT_RETRY_ATTEMPTS) {
        throw error;
      }
      const delay = IMAGE_TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      log.warn(
        `Image provider transport error (attempt ${attempt}/${IMAGE_TRANSIENT_RETRY_ATTEMPTS}), ` +
          `retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// The ComfyUI adapter polls up to GENERATION_TIMEOUT_MS (5 min) and real
// workflows can take 3–5 min. 60s would let platforms that enforce maxDuration
// (e.g. Vercel) kill the request ~4 min before the adapter finishes. 300s is
// the practical ceiling on most managed platforms and matches the poll budget.
// (Self-hosted Node servers ignore this value entirely.)
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ImageGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    // The client may express no provider preference (empty header) — fall back
    // to the first server-configured image provider, else fail loud.
    const providerId = (request.headers.get('x-image-provider')?.trim() ||
      resolveServerImageProviderId()) as ImageProviderId;
    if (!providerId) {
      return apiError('MISSING_PROVIDER', 400, 'No image provider configured');
    }
    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection — mirror the TTS contract (#665).
    if (isServerProviderDisabled('image', providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This image provider is disabled by the server');
    }
    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
    const clientModel = request.headers.get('x-image-model')?.trim() || undefined;

    if (clientBaseUrl) {
      const ssrfError = await validateUrlForSSRF(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for image provider: ${providerId}`,
      );
    }

    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    // A managed provider may pin its model list server-side
    // (IMAGE_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
    // first pinned entry is the managed default; unmanaged providers use the
    // client header directly.
    const model = resolveImageModel(providerId, clientModel);
    // Workflow-based providers (e.g. comfyui-image) have no model catalog and
    // need no model; everyone else must resolve one.
    if (!model && provider?.models && provider.models.length > 0) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for image provider: ${providerId}`,
      );
    }

    const sizedOptions = resolveImageSize(body, { providerId, modelId: model });

    log.info(
      `Generating image: provider=${providerId}, model=${model || 'default'}, ` +
        `prompt="${sizedOptions.prompt.slice(0, 80)}...", size=${sizedOptions.width ?? 'auto'}x${sizedOptions.height ?? 'auto'}`,
    );

    const result = await generateImageWithTransientRetry(
      { providerId, apiKey, baseUrl, model },
      sizedOptions,
    );

    void recordGenerationUsage({
      kind: 'image',
      unit: 'image',
      providerId,
      modelId: model,
      quantity: 1,
    });

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Detect content safety filter rejections (e.g. Seedream OutputImageSensitiveContentDetected)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Image blocked by content safety filter: ${message}`);
      return apiError('CONTENT_SENSITIVE', 400, message);
    }
    log.error(`Image generation failed: ${message}`, error);
    return apiError('INTERNAL_ERROR', 500, message);
  }
}
