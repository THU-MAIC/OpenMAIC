import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { resolveModel } from '@/lib/server/resolve-model';
import { callLLM } from '@/lib/ai/llm';
import { upstreamHttpStatus } from '@/lib/server/llm-error-response';
const log = createLogger('Verify Model');

export async function POST(req: NextRequest) {
  let model: string | undefined;
  try {
    const body = await req.json();
    const { apiKey, baseUrl, providerType } = body;
    model = body.model;

    if (!model) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Model name is required');
    }

    // Parse model string and resolve server-side fallback
    let languageModel;
    try {
      const result = await resolveModel({
        modelString: model,
        apiKey: apiKey || '',
        baseUrl: baseUrl || undefined,
        providerType,
      });
      languageModel = result.model;
    } catch (error) {
      return apiError(
        'INVALID_REQUEST',
        401,
        error instanceof Error ? error.message : String(error),
      );
    }

    // Send a minimal test message. Use the unified wrapper so compatible
    // providers can receive provider-specific request options.
    const { text } = await callLLM(
      {
        model: languageModel,
        prompt: 'Say "OK" if you can hear me.',
        maxOutputTokens: 64,
      },
      'verify-model',
      undefined,
      // Probe the exact model the user typed in — a fallback would report a
      // dead or mis-keyed model as healthy. The shared layer disables the
      // fallback for the 'verify-model' source automatically.
      { mode: 'disabled', enabled: false },
    );

    return apiSuccess({
      message: 'Connection successful',
      response: text,
    });
  } catch (error) {
    log.error(`Model verification failed [model="${model ?? 'unknown'}"]:`, error);

    // Classify by the provider's HTTP status only. Error messages can carry the
    // provider's response body or transport detail, so they are logged above
    // and never returned.
    const status = upstreamHttpStatus(error);
    let errorMessage: string;
    if (status === 401 || status === 403) {
      errorMessage = 'API key is invalid or expired';
    } else if (status === 404) {
      errorMessage = 'Model not found or API endpoint error';
    } else if (status === 429) {
      errorMessage = 'API rate limit exceeded, please try again later';
    } else if (status !== undefined) {
      errorMessage = `API request failed (HTTP ${Math.floor(status / 100)}xx)`;
    } else {
      // Refused, unresolvable, timed-out, redirecting and policy-blocked
      // targets, and unreadable responses, all get the same answer.
      errorMessage = 'Cannot connect to API server, please check the Base URL';
    }

    return apiError('INTERNAL_ERROR', 500, errorMessage);
  }
}
