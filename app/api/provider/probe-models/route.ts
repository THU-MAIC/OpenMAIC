import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateClientBaseUrl, validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { fetchModels, ModelFetchError } from '@/lib/server/model-fetch';
import {
  savedChatEndpoint,
  savedProviderRef,
  savedProviderResponse,
} from '@/lib/server/model-config/saved-provider';

const log = createLogger('ProbeModels');

/** Model ids that are not chat models — filtered out of probe results. */
const NON_CHAT_PATTERN = /(tts|asr|whisper|embedding|rerank|mineru|image|video|voxcpm|moderation)/i;

/**
 * POST /api/provider/probe-models
 *
 * Discovers the chat models a base URL + key exposes, via the OpenAI-compatible
 * /models endpoint (with multi-candidate fallback). Returns the lit-up list, or
 * a typed status so the UI can fall back to manual model entry.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }
  try {
    let { baseUrl, apiKey, modelsUrl } = body as {
      baseUrl?: string;
      apiKey?: string;
      modelsUrl?: string;
    };
    // The settings name one of the workspace's own providers (`provider`):
    // its stored endpoint and key are used, and nothing else from the request.
    const saved = (body as { provider?: unknown }).provider;
    if (saved !== undefined) {
      try {
        const ref = savedProviderRef(saved);
        if (!ref) return apiError('MISSING_REQUIRED_FIELD', 400, 'provider is required');
        ({ baseUrl, apiKey } = await savedChatEndpoint(req, ref));
        modelsUrl = undefined;
      } catch (error) {
        const refused = savedProviderResponse(error, 'language model');
        if (refused) return refused;
        throw error;
      }
    }

    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'baseUrl is required');
    }

    // SSRF guard on both the base URL and an explicit models URL override
    // (a complete URL, so only the base URL is held to the base-URL shape).
    const baseUrlError = await validateClientBaseUrl(baseUrl);
    if (baseUrlError) return apiError('INVALID_REQUEST', 400, baseUrlError);
    if (modelsUrl) {
      const ssrfError = await validateUrlForSSRF(modelsUrl);
      if (ssrfError) return apiError('INVALID_REQUEST', 400, ssrfError);
    }

    const models = await fetchModels(baseUrl, apiKey || '', { modelsUrlOverride: modelsUrl });
    const chatModels = models.filter((m) => !NON_CHAT_PATTERN.test(m.id));

    return apiSuccess({
      models: chatModels.map((m) => ({ id: m.id, ownedBy: m.ownedBy })),
      total: models.length,
      filtered: models.length - chatModels.length,
    });
  } catch (error) {
    // Only fixed messages reach the caller: the provider's body, parser output
    // and transport errors are logged server-side.
    log.warn('Model probe failed:', error);
    if (error instanceof ModelFetchError) {
      if (error.status >= 300 && error.status < 400) {
        return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
      }
      if (error.status === 401 || error.status === 403) {
        return apiError('INVALID_REQUEST', 401, 'API key is invalid or expired');
      }
      if (error.status === 404) {
        // No /models endpoint — signal the UI (via 404) to use manual model entry.
        return apiError('INVALID_REQUEST', 404, 'This provider does not expose a model list');
      }
      if (error.status >= 200 && error.status < 300) {
        return apiError('UPSTREAM_ERROR', 502, 'The provider returned an invalid model list');
      }
      return apiError(
        'UPSTREAM_ERROR',
        502,
        `The provider rejected the model list request (HTTP ${Math.floor(error.status / 100)}xx)`,
      );
    }
    // Refused, unresolvable, timed-out and policy-blocked targets all get the
    // same answer.
    return apiError(
      'UPSTREAM_ERROR',
      502,
      'Cannot connect to the provider, please check the Base URL',
    );
  }
}
