/**
 * Verify Image Provider API
 *
 * Lightweight endpoint that validates provider credentials without generating images.
 *
 * POST /api/verify-image-provider
 *
 * Response: { success: boolean, message: string }
 */
import { modelAuthorizationResponse } from '@/lib/server/api-response';

import { NextRequest } from 'next/server';
import { IMAGE_PROVIDERS, testImageConnectivity } from '@/lib/media/image-providers';
import type { ImageProviderId } from '@/lib/media/types';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { withMediaProviderFetch } from '@/lib/server/media-provider-fetch';
import {
  savedMediaConnection,
  savedProviderRef,
  savedProviderResponse,
} from '@/lib/server/model-config/saved-provider';

const log = createLogger('VerifyImageProvider');

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

    return apiError('MISSING_PROVIDER', 400, 'No image provider named');
  } catch (err) {
    const authorization = modelAuthorizationResponse(err);
    if (authorization) return authorization;
    log.error(`Image provider verification failed: ${err}`, err);
    return apiError('INTERNAL_ERROR', 500, 'Connectivity test error');
  }
}
