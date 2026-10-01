/**
 * Image Generation API
 *
 * Generates an image from a text prompt using the specified provider.
 * Called by the client during media generation after slides are produced.
 *
 * POST /api/generate/image
 *
 * The provider comes from the image slot of the model configuration. The
 * headers below are deprecated and count only while the slot is unassigned:
 *   x-image-provider, x-image-model, x-api-key, x-base-url
 *
 * Body: { prompt, negativePrompt?, width?, height?, aspectRatio?, style? }
 * Response: { success: boolean, result?: ImageGenerationResult, error?: string }
 */

import { NextRequest } from 'next/server';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
} from '@/lib/server/provider-config';
import {
  mediaResolutionResponse,
  RequestedProviderRefusedError,
  resolveMediaSlot,
  type MediaConnection,
} from '@/lib/server/model-config/media';
import { requestWorkspaceId } from '@/lib/server/model-config/runtime';
import type { ImageProviderId, ImageGenerationOptions } from '@/lib/media/types';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, type ApiErrorCode } from '@/lib/server/api-response';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import { generateImageStep, type ImageRefusal } from '@/lib/server/generation/steps/image';

const log = createLogger('ImageGeneration API');

// The ComfyUI adapter polls up to GENERATION_TIMEOUT_MS (5 min) and real
// workflows can take 3–5 min. 60s would let platforms that enforce maxDuration
// (e.g. Vercel) kill the request ~4 min before the adapter finishes. 300s is
// the practical ceiling on most managed platforms and matches the poll budget.
// (Self-hosted Node servers ignore this value entirely.)
export const maxDuration = 300;

const REFUSAL_RESPONSES: Record<ImageRefusal, [ApiErrorCode, number]> = {
  'missing-api-key': ['MISSING_API_KEY', 401],
  'missing-model': ['MISSING_MODEL', 400],
};

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ImageGenerationOptions;

    if (!body.prompt) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing prompt');
    }

    // The image slot decides; the provider a request names (x-image-provider
    // with its key and base URL, deprecated) counts only when it is unassigned.
    let connection: MediaConnection;
    try {
      connection = await resolveMediaSlot('image', {
        workspaceId: await requestWorkspaceId(request),
        legacyRequest: () => requestedImageProvider(request),
      });
    } catch (error) {
      const refused = mediaResolutionResponse(error, 'Image generation');
      if (refused) return refused;
      throw error;
    }
    let result;
    try {
      result = await generateImageStep(
        {
          options: body,
          connection,
          requestedModel: request.headers.get('x-image-model')?.trim() || undefined,
        },
        { log },
      );
    } catch (error) {
      if (!(error instanceof StepRefusal)) throw error;
      const [code, status] = REFUSAL_RESPONSES[error.reason as ImageRefusal];
      return apiError(code, status, error.message);
    }

    return apiSuccess({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The provider's error text is logged only; the caller gets a fixed message
    // so an upstream body never reaches the response.
    // Detect content safety filter rejections (e.g. Seedream OutputImageSensitiveContentDetected)
    if (message.includes('SensitiveContent') || message.includes('sensitive information')) {
      log.warn(`Image blocked by content safety filter: ${message}`);
      return apiError(
        'CONTENT_SENSITIVE',
        400,
        'The image provider rejected this prompt under its content safety policy',
      );
    }
    log.error(`Image generation failed: ${message}`, error);
    return apiError('INTERNAL_ERROR', 500, 'Image generation failed');
  }
}

/**
 * The provider the request names with x-image-provider (deprecated), with the
 * key, base URL and model headers, or undefined when it names none.
 */
async function requestedImageProvider(request: NextRequest): Promise<MediaConnection | undefined> {
  const providerId = request.headers.get('x-image-provider')?.trim() as ImageProviderId | undefined;
  if (!providerId) return undefined;
  // A force-disabled provider is off for everyone (#665).
  if (isServerProviderDisabled('image', providerId)) {
    throw new RequestedProviderRefusedError(
      apiError('PROVIDER_DISABLED', 403, 'This image provider is disabled by the server'),
    );
  }
  // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
  const managed = isServerConfiguredProvider('image', providerId);
  const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
  const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;
  if (clientBaseUrl) {
    const ssrfError = await validateClientBaseUrl(clientBaseUrl);
    if (ssrfError) throw new RequestedProviderRefusedError(apiError('INVALID_URL', 403, ssrfError));
  }
  // A managed provider may pin its model list server-side
  // (IMAGE_<PREFIX>_MODELS): an allowlisted client choice wins, otherwise the
  // first pinned entry is the managed default.
  const model = resolveImageModel(
    providerId,
    request.headers.get('x-image-model')?.trim() || undefined,
  );
  return {
    providerId,
    apiKey: resolveImageApiKey(providerId, clientApiKey),
    ...(model ? { modelId: model } : {}),
    baseUrl: resolveImageBaseUrl(providerId, clientBaseUrl),
    managed,
    userEndpoint: Boolean(clientBaseUrl),
    origin: 'request',
  };
}
