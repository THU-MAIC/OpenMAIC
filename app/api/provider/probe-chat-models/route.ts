import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { fetchWithTimeout } from '@/lib/server/fetch-with-timeout';

const log = createLogger('ProbeChatModels');

const PROBE_TIMEOUT_MS = 20_000;
/** Cap how many candidates we'll verify, so a bad preset can't fan out forever. */
const MAX_CANDIDATES = 32;

/** What kind of model is being verified — picks the endpoint + request shape. */
type ProbeKind = 'chat' | 'image' | 'video';

/** Builds the verification request for one candidate model. */
function buildProbe(
  root: string,
  apiKey: string,
  model: string,
  kind: ProbeKind,
  apiFormat: 'openai' | 'anthropic',
): { url: string; init: RequestInit } {
  const jsonHeaders = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (kind === 'image') {
    // Minimal image request — an empty prompt is rejected for params (400) but
    // an unsupported model still 404s first (the check we care about).
    return {
      url: `${root}/images/generations`,
      init: { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model, prompt: '' }) },
    };
  }
  if (kind === 'video') {
    // Empty content: the model-support check (404 UnsupportedModel) runs before
    // task creation, so this never starts a billable job.
    return {
      url: `${root}/contents/generations/tasks`,
      init: { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ model, content: [] }) },
    };
  }
  if (apiFormat === 'anthropic') {
    return {
      url: `${root}/messages`,
      init: {
        method: 'POST',
        headers: { ...jsonHeaders, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      },
    };
  }
  return {
    url: `${root}/chat/completions`,
    init: {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    },
  };
}

/**
 * Verifies a model id is usable with this key.
 * - chat: success = a 2xx (the request fully resolves).
 * - image/video: success = NOT a 404 (a 404 "UnsupportedModel" means the model
 *   isn't in this plan tier; a 400 param error still means the model is allowed,
 *   and the support check runs before any billable work).
 * Auth failures (401/403) short-circuit the whole batch via `onAuthFail`.
 * Network/timeout counts as "no" (don't keep an unverifiable model).
 */
async function verifyModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  kind: ProbeKind,
  apiFormat: 'openai' | 'anthropic',
  onAuthFail: () => void,
): Promise<boolean> {
  const root = baseUrl.replace(/\/+$/, '');
  const { url, init } = buildProbe(root, apiKey, model, kind, apiFormat);
  try {
    const res = await fetchWithTimeout(url, init, PROBE_TIMEOUT_MS);
    if (res.status === 401 || res.status === 403) {
      onAuthFail();
      return false;
    }
    if (kind === 'chat') return res.ok;
    // image/video: anything but 404 means the model is allowed on this tier.
    return res.status !== 404;
  } catch {
    return false;
  }
}

/**
 * POST /api/provider/probe-chat-models
 *
 * Verifies a CANDIDATE model list against a base URL + key by sending each a
 * minimal request, in parallel. Returns the subset that's usable. For plans that
 * publish a model set but expose no /models endpoint (e.g. Volcengine Agent
 * Plan) — auto-prunes retired/tier-gated models. `kind` selects the endpoint:
 * chat (default), image, or video.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { baseUrl, apiKey, models, apiFormat, kind } = body as {
      baseUrl?: string;
      apiKey?: string;
      models?: string[];
      apiFormat?: 'openai' | 'anthropic';
      kind?: ProbeKind;
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
    const probeKind: ProbeKind = kind === 'image' || kind === 'video' ? kind : 'chat';

    let authFailed = false;
    const results = await Promise.all(
      candidates.map(async (model) => ({
        model,
        ok: await verifyModel(baseUrl, apiKey, model, probeKind, format, () => {
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
    log.error('Model probe failed:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to probe models',
    );
  }
}
