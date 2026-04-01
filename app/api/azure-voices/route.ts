import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError, apiSuccess } from '@/lib/server/api-response';
const log = createLogger('Azure Voices');

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
    const ssrfError = validateUrlForSSRF(baseUrl);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    // Call Azure voices list endpoint; disable redirect following to prevent SSRF via redirect
    const response = await fetch(`${baseUrl}/cognitiveservices/voices/list`, {
      method: 'GET',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
      },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirects are not allowed');
    }

    if (!response.ok) {
      const errorText = await response.text();
      return apiError(
        'UPSTREAM_ERROR',
        response.status,
        'Failed to fetch voices from Azure',
        errorText || response.statusText,
      );
    }

    const voices = await response.json();

    return apiSuccess({ voices });
  } catch (error) {
    log.error(`Azure voices fetch failed [baseUrl="${baseUrl ?? 'unknown'}"]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to fetch voices',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
