/**
 * Verify Image Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating images.
 *
 * POST /api/verify-image-provider
 *
 * Headers:
 *   x-image-provider: ImageProviderId (optional, server-configured default)
 *   x-image-model: string (optional)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { IMAGE_PROVIDERS, testImageConnectivity } from '@/lib/media/image-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveImageModel,
  resolveServerImageProviderId,
} from '@/lib/server/provider-config';
import type { ImageProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import {
  savedMediaConnection,
  savedProviderRef,
  savedProviderResponse,
} from '@/lib/server/model-config/saved-provider';
import { requestProvidersAllowed } from '@/lib/server/model-config/runtime';
import { REQUEST_PROVIDERS_REFUSED } from '@/lib/server/resolve-model';

const log = createLogger('VerifyImageProvider');

// Connectivity probes are lightweight and each underlying request is bounded by
// its own AbortSignal, but the route had no ceiling at all — cap it so a stalled
// upstream can't tie up the function indefinitely.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    // The settings test a saved provider by its id (JSON body `provider`, with
    // an optional `model`): the server's configuration supplies key and endpoint.
    const body = request.headers.get('content-type')?.includes('application/json')
      ? ((await request.json().catch(() => null)) as { provider?: unknown; model?: unknown } | null)
      : null;
    if (body?.provider !== undefined) {
      let connection;
      try {
        const ref = savedProviderRef(body.provider, body.model);
        if (!ref) return apiError('MISSING_PROVIDER', 400, 'No image provider named');
        connection = await savedMediaConnection(request, 'image', ref);
      } catch (error) {
        const refused = savedProviderResponse(error, 'image');
        if (refused) return refused;
        throw error;
      }
      const providerId = connection.providerId as ImageProviderId;
      const model = connection.modelId ?? IMAGE_PROVIDERS[providerId]?.models?.[0]?.id;
      const result = await testImageConnectivity(
        withMediaProviderFetch(
          { providerId, apiKey: connection.apiKey ?? '', baseUrl: connection.baseUrl, model },
          connection.managed,
        ),
      );
      if (!result.success) return apiError('UPSTREAM_ERROR', 500, result.message);
      return apiSuccess({ message: result.message });
    }

    // The old header form tests a provider the request names: not under
    // `policy.allowWorkspaceProviders: false`, which leaves only the
    // configuration's providers (tested by id above).
    if (!requestProvidersAllowed()) {
      return apiError('PROVIDER_DISABLED', 403, REQUEST_PROVIDERS_REFUSED);
    }

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
    const clientModel = request.headers.get('x-image-model')?.trim() || undefined;
    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('image', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;

    if (clientBaseUrl) {
      const ssrfError = await validateClientBaseUrl(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveImageApiKey(providerId, clientApiKey);
    const baseUrl = resolveImageBaseUrl(providerId, clientBaseUrl);

    const provider = IMAGE_PROVIDERS[providerId];
    if (provider?.requiresApiKey && !apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

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

    // Every probe request runs on the pinned provider transport; the adapters'
    // result messages are fixed text (no provider body, no transport detail).
    const result = await testImageConnectivity(
      withMediaProviderFetch({ providerId, apiKey, baseUrl, model }, managed),
    );

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

    return apiSuccess({ message: result.message });
  } catch (err) {
    log.error(`Image provider verification failed: ${err}`, err);
    return apiError('INTERNAL_ERROR', 500, 'Connectivity test error');
  }
}
