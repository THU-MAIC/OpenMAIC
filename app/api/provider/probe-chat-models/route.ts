import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { fetchWithTimeout } from '@/lib/server/fetch-with-timeout';

const log = createLogger('ProbeChatModels');

const PROBE_TIMEOUT_MS = 20_000;
/** Cap how many candidates we'll verify, so a bad preset can't fan out forever. */
const MAX_CANDIDATES = 32;

/**
 * Sends one minimal chat request to verify a model id is callable with this
 * key. Returns true on a 2xx. A 404 "model not supported" / 400 bad-model is a
 * clean "no"; network/timeout also counts as "no" (don't keep an unverifiable
 * model). Auth failures (401/403) short-circuit the whole batch via `onAuthFail`.
 */
async function verifyModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  apiFormat: 'openai' | 'anthropic',
  onAuthFail: () => void,
): Promise<boolean> {
  const root = baseUrl.replace(/\/+$/, '');
  try {
    let res: Response;
    if (apiFormat === 'anthropic') {
      res = await fetchWithTimeout(
        `${root}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
        PROBE_TIMEOUT_MS,
      );
    } else {
      res = await fetchWithTimeout(
        `${root}/chat/completions`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        },
        PROBE_TIMEOUT_MS,
      );
    }
    if (res.status === 401 || res.status === 403) {
      onAuthFail();
      return false;
    }
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * POST /api/provider/probe-chat-models
 *
 * Verifies a CANDIDATE model list against a base URL + key by sending each a
 * minimal chat request, in parallel. Returns the subset that succeeds. For
 * plans that publish a model set but expose no /models endpoint (e.g. Volcengine
 * Agent Plan) — auto-prunes retired/tier-gated models.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { baseUrl, apiKey, models, apiFormat } = body as {
      baseUrl?: string;
      apiKey?: string;
      models?: string[];
      apiFormat?: 'openai' | 'anthropic';
    };

    if (!baseUrl) return apiError('MISSING_REQUIRED_FIELD', 400, 'baseUrl is required');
    if (!apiKey) return apiError('MISSING_REQUIRED_FIELD', 400, 'apiKey is required');
    if (!Array.isArray(models) || models.length === 0) {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'models[] is required');
    }

    const ssrfError = await validateUrlForSSRF(baseUrl);
    if (ssrfError) return apiError('INVALID_REQUEST', 400, ssrfError);

    const candidates = models.slice(0, MAX_CANDIDATES);
    const format = apiFormat === 'anthropic' ? 'anthropic' : 'openai';

    let authFailed = false;
    const results = await Promise.all(
      candidates.map(async (model) => ({
        model,
        ok: await verifyModel(baseUrl, apiKey, model, format, () => {
          authFailed = true;
        }),
      })),
    );

    if (authFailed) {
      return apiError('INVALID_REQUEST', 401, 'API key is invalid or expired');
    }

    return apiSuccess({
      models: results.filter((r) => r.ok).map((r) => ({ id: r.model })),
      total: candidates.length,
    });
  } catch (error) {
    log.error('Chat-model probe failed:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to probe chat models',
    );
  }
}
