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
import { recordGenerationUsage } from '@/lib/server/usage-storage';
import { generateImage, IMAGE_PROVIDERS } from '@/lib/media/image-providers';
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
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';
import { mediaNetworkPolicy, withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import { resolveImageSize } from '@/lib/server/image-sizing';

const log = createLogger('ImageGeneration API');

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
    const { providerId, apiKey, baseUrl } = connection as MediaConnection & {
      providerId: ImageProviderId;
    };
    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError(
        'MISSING_API_KEY',
        401,
        `No API key configured for image provider: ${providerId}`,
      );
    }
    // A configured slot without a model uses the provider's first catalogue
    // model. On the legacy default provider the request's model still applies
    // through its allowlist, as before slots.
    const model =
      connection.origin === 'configuration'
        ? (connection.modelId ?? provider?.models?.[0]?.id)
        : connection.origin === 'default'
          ? resolveImageModel(providerId, request.headers.get('x-image-model')?.trim() || undefined)
          : connection.modelId;
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

    const result = await generateImage(
      withMediaProviderFetch(
        { providerId, apiKey: apiKey ?? '', baseUrl, model },
        mediaNetworkPolicy(connection),
      ),
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
