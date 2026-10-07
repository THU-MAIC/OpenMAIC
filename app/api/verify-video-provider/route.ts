/**
 * Verify Video Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating video.
 *
 * POST /api/verify-video-provider
 *
 * Headers:
 *   x-video-provider: VideoProviderId (optional, server-configured default)
 *   x-video-model: string (optional)
 *   x-api-key: string (optional, server fallback)
 *   x-base-url: string (optional, server fallback)
 *
 * Response: { success: boolean, message: string }
 */

import { NextRequest } from 'next/server';
import { testVideoConnectivity, VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import {
  isServerConfiguredProvider,
  isServerProviderDisabled,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveVideoModel,
  resolveServerVideoProviderId,
} from '@/lib/server/provider-config';
import type { VideoProviderId } from '@/lib/media/types';
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

const log = createLogger('VerifyVideoProvider');

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
        if (!ref) return apiError('MISSING_PROVIDER', 400, 'No video provider named');
        connection = await savedMediaConnection(request, 'video', ref);
      } catch (error) {
        const refused = savedProviderResponse(error, 'video');
        if (refused) return refused;
        throw error;
      }
      const providerId = connection.providerId as VideoProviderId;
      const model = connection.modelId ?? VIDEO_PROVIDERS[providerId]?.models?.[0]?.id;
      const result = await testVideoConnectivity(
        withMediaProviderFetch(
          { providerId, apiKey: connection.apiKey ?? '', baseUrl: connection.baseUrl, model },
          connection.managed,
        ),
      );
      if (!result.success) return apiError('UPSTREAM_ERROR', 500, result.message);
      return apiSuccess({ message: result.message });
    }

    // The old header form tests a provider the request names: not under
    // `allowUserKeys: false`, which leaves only the
    // configuration's providers (tested by id above).
    if (!requestProvidersAllowed()) {
      return apiError('PROVIDER_DISABLED', 403, REQUEST_PROVIDERS_REFUSED);
    }

    const providerId = (request.headers.get('x-video-provider')?.trim() ||
      resolveServerVideoProviderId()) as VideoProviderId;
    if (!providerId) {
      return apiError('MISSING_PROVIDER', 400, 'No video provider configured');
    }
    // Enforce server precedence: a force-disabled provider is off for everyone,
    // regardless of any client key/selection — mirror the TTS contract (#665).
    if (isServerProviderDisabled('video', providerId)) {
      return apiError('PROVIDER_DISABLED', 403, 'This video provider is disabled by the server');
    }
    const clientModel = request.headers.get('x-video-model')?.trim() || undefined;
    // Managed providers are admin-owned: ignore any client-sent key/baseUrl.
    const managed = isServerConfiguredProvider('video', providerId);
    const clientApiKey = managed ? undefined : request.headers.get('x-api-key') || undefined;
    const clientBaseUrl = managed ? undefined : request.headers.get('x-base-url') || undefined;

    if (clientBaseUrl) {
      const ssrfError = await validateClientBaseUrl(clientBaseUrl);
      if (ssrfError) {
        return apiError('INVALID_URL', 403, ssrfError);
      }
    }

    const apiKey = resolveVideoApiKey(providerId, clientApiKey);
    const baseUrl = resolveVideoBaseUrl(providerId, clientBaseUrl);

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'No API key configured');
    }

    const model = resolveVideoModel(providerId, clientModel);
    if (!model) {
      return apiError(
        'MISSING_MODEL',
        400,
        `No model configured for video provider: ${providerId}`,
      );
    }

    // Every probe request runs on the pinned provider transport; the adapters'
    // result messages are fixed text (no provider body, no transport detail).
    const result = await testVideoConnectivity(
      withMediaProviderFetch({ providerId, apiKey, baseUrl, model }, managed),
    );

    if (!result.success) {
      return apiError('UPSTREAM_ERROR', 500, result.message);
    }

    return apiSuccess({ message: result.message });
  } catch (err) {
    log.error(`Video provider verification failed: ${err}`, err);
    return apiError('INTERNAL_ERROR', 500, 'Connectivity test error');
  }
}
