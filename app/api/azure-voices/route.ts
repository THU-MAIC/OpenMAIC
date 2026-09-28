import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { validateClientBaseUrl } from '@/lib/server/ssrf-guard';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
const log = createLogger('Azure Voices');

// The caller-supplied base URL runs under the operator address policy (the one
// `validateUrlForSSRF` applied: `allowLocalNetworks` unset falls back to
// ALLOW_LOCAL_NETWORKS). The strict transport pins the connect address to the
// vetted DNS answers, and a 3xx is refused rather than followed.
const VOICES_POLICY: ProviderFetchPolicy = { allowLocalNetworks: undefined, rejectRedirects: true };

// Fixed messages: the target's status, body and transport errors are logged
// server-side only and never echoed back to the caller.
const AUTH_FAILED_MESSAGE = 'Authentication failed, please check the API Key';
const FETCH_FAILED_MESSAGE = 'Failed to fetch voices from Azure';

export const maxDuration = 30;

/**
 * Azure TTS Voice List API
 * Fetches available voices from Azure Speech Services
 */
export async function POST(req: NextRequest) {
  let baseUrl: string | undefined;
  try {
    const body = await req.json();
    const { apiKey } = body;
    baseUrl = body.baseUrl;

    if (!apiKey) {
      return apiError('MISSING_API_KEY', 400, 'API Key is required');
    }

    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Base URL is required');
    }

    // Validate baseUrl against SSRF
    const ssrfError = await validateClientBaseUrl(baseUrl);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    // Call Azure voices list endpoint
    const response = await providerFetch(
      `${baseUrl}/cognitiveservices/voices/list`,
      {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
        },
        signal: AbortSignal.timeout(20_000),
      },
      VOICES_POLICY,
    );

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      log.warn(`Azure voices request rejected [status=${response.status}]`);
      if (response.status === 401 || response.status === 403) {
        return apiError('UPSTREAM_ERROR', 502, AUTH_FAILED_MESSAGE);
      }
      return apiError('UPSTREAM_ERROR', 502, FETCH_FAILED_MESSAGE);
    }

    // Only a voice list is returned; anything else (including a body that is
    // not JSON) is answered with the fixed message.
    const voices: unknown = await response.json().catch(() => undefined);
    if (!Array.isArray(voices)) {
      log.warn('Azure voices response was not a voice list');
      return apiError('UPSTREAM_ERROR', 502, FETCH_FAILED_MESSAGE);
    }

    return apiSuccess({ voices });
  } catch (error) {
    log.error(`Azure voices fetch failed [baseUrl="${baseUrl ?? 'unknown'}"]:`, error);
    // Refused, unresolvable, timed-out, redirecting and policy-blocked targets
    // all get the same answer.
    return apiError('INTERNAL_ERROR', 500, FETCH_FAILED_MESSAGE);
  }
}
