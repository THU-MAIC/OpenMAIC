import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { queryBalance } from '@/lib/usage/balance-providers';

const log = createLogger('ProviderBalance');

/**
 * POST /api/provider/balance
 *
 * Queries the remaining balance/quota for a base URL + key. Tries a detected
 * built-in provider (DeepSeek/SiliconFlow/OpenRouter/StepFun), then the
 * OpenAI-legacy billing endpoints (one-api/new-api/MAIC). Returns
 * { supported: false } when neither applies so the UI shows a console hint.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { baseUrl, apiKey } = body as { baseUrl?: string; apiKey?: string };

    if (!baseUrl) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'baseUrl is required');
    }
    if (!apiKey) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'apiKey is required');
    }

    const ssrfError = await validateUrlForSSRF(baseUrl);
    if (ssrfError) return apiError('INVALID_REQUEST', 400, ssrfError);

    const result = await queryBalance(baseUrl, apiKey);
    return apiSuccess({ balance: result });
  } catch (error) {
    log.error('Balance query failed:', error);
    // A failed balance query is non-fatal — report unsupported rather than 500.
    return apiSuccess({ balance: { supported: false } });
  }
}
