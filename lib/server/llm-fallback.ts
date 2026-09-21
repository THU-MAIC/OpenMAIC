/**
 * Retryable-failure model fallback (PR #1614).
 *
 * A small, operator-configured safety net for generation calls: when a call
 * fails with a retryable error (timeout, empty output, network, quota 429,
 * capacity 503), retry once on a different model. Configuration lives on the
 * server like the existing routes:
 *
 *   MODEL_ROUTES='{"scene-content":{"model":"openai:gpt-5.4","fallback":"qwen:deepseek-v4-pro"}}'
 *   MODEL_FALLBACK='qwen:deepseek-v4-pro'   # optional global fallback
 *
 * `verify-model` opts out (option in callLLM): it probes the exact model the
 * user typed in, and answering from a different model would report a dead or
 * mis-keyed model as healthy. Content-safety rejections and other 4xx failures
 * never fall back — retrying a rejected prompt on a second model would spend
 * that model's quota to reproduce the same rejection.
 *
 * This module is imported lazily from lib/ai/llm.ts so the shared call layer
 * stays safe to bundle wherever it is transitively imported.
 */

import type { LanguageModel } from 'ai';
import type { LlmStage } from '@/lib/server/model-routes';
import { getStageRoute } from '@/lib/server/model-routes';
import { getModel, parseModelString } from '@/lib/ai/providers';
import { resolveApiKey, resolveBaseUrl, resolveProxy } from '@/lib/server/provider-config';
import { fetchWithRedirectValidation } from '@/lib/server/fetch-with-redirect-validation';

export interface FallbackResolution {
  /** The fallback language model, ready to hand to callLLM/streamLLM. */
  model: LanguageModel;
  /** Canonical `provider:model` string of the fallback, for logs. */
  modelString: string;
}

/**
 * Resolve the fallback model for a stage, or null when none is configured.
 *
 * Order: per-stage `MODEL_ROUTES.<stage>.fallback`, then global `MODEL_FALLBACK`.
 * The resolved model is built from server config only (never client headers),
 * mirroring how a routed stage model is built in resolveModel.
 */
export async function resolveFallbackModel(source: string): Promise<FallbackResolution | null> {
  const stageRoute = getStageRoute(source as LlmStage);
  const fallbackStr = stageRoute?.fallback ?? process.env.MODEL_FALLBACK?.trim();
  if (!fallbackStr) return null;

  const { providerId, modelId } = parseModelString(fallbackStr);
  const apiKey = resolveApiKey(providerId, '');
  const baseUrl = resolveBaseUrl(providerId);
  const proxy = resolveProxy(providerId);
  const { model } = getModel({
    providerId,
    modelId,
    apiKey,
    baseUrl,
    proxy,
    // Re-validate every redirect hop of the outbound request, same as resolveModel.
    fetchImpl: fetchWithRedirectValidation,
  });
  return { model, modelString: fallbackStr };
}

/**
 * Whether an error falls into the retryable set that may trigger a fallback.
 *
 * Retryable: upstream capacity/timing (408 timeout, 429 quota, 5xx), and
 * transport-level network failures. Anything else — 4xx validation/auth,
 * unknown non-AI errors — is kept as-is so the fallback never hides the real
 * cause (a bad prompt or a mis-keyed provider would only reproduce elsewhere).
 */
export function isRetryableLlmError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const asAny = error as { name?: unknown; statusCode?: unknown };
  const statusCode = typeof asAny.statusCode === 'number' ? asAny.statusCode : undefined;

  if (statusCode !== undefined) {
    if (
      statusCode === 408 ||
      statusCode === 429 ||
      statusCode === 500 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504
    ) {
      return true;
    }
    // 400/401/403/404 … are not transient — do not fall back.
    return false;
  }

  if (asAny.name === 'AI_APICallError' || asAny.name === 'APICallError') {
    // API error without a numeric status: treat as non-transient, except
    // message-level timeout signals some runtimes report this way.
    return /timeout|timed ?out/i.test(error.message);
  }

  // Transport-level failures surface as TypeErrors (fetch) or with connection
  // codes (undici). Unknown errors are conservative: fail in place.
  if (error instanceof TypeError) return true;
  return /ECONN|ENOTFOUND|ECONNRESET|UND_ERR|socket hang up|timeout/i.test(error.message);
}
