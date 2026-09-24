/**
 * Retryable-failure model fallback (PR #1614).
 *
 * A small, operator-configured safety net for generation calls: when a call
 * fails with a retryable failure (SDK-classified transient error, timeout,
 * empty output, network error, quota 429, capacity 503), retry once on a
 * different model. Configuration lives on the server like the existing routes:
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

import { APICallError, RetryError } from 'ai';
import type { LanguageModel } from 'ai';
import type { LlmStage } from '@/lib/server/model-routes';
import { getStageRoute } from '@/lib/server/model-routes';
import { getModel, parseModelString } from '@/lib/ai/providers';
import { resolveApiKey, resolveBaseUrl, resolveProxy } from '@/lib/server/provider-config';
import { fetchWithRedirectValidation } from '@/lib/server/fetch-with-redirect-validation';
import { createLogger } from '@/lib/logger';

const log = createLogger('LLM Fallback');

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
 * Unwrap the AI SDK retry chain down to the innermost reportable error.
 *
 * `maxRetries` retries exhaust as a `RetryError` whose `lastError` (and
 * `errors[]`) hold the original provider failure; an `APICallError` in turn may
 * nest the HTTP failure itself in `cause`. Walk all three, cycle-safe.
 */
function unwrapRetryChain(error: unknown, seen: Set<unknown> = new Set()): unknown {
  if (!(error instanceof Error) || seen.has(error)) return error;
  seen.add(error);
  if (RetryError.isInstance(error)) {
    const last = error.lastError ?? error.errors?.[error.errors.length - 1];
    return unwrapRetryChain(last, seen);
  }
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? unwrapRetryChain(cause, seen) : error;
}

/** Explicit network-transport signal in a message (fetch-level failures). */
const NETWORK_ERROR_RE =
  /Cannot connect to API|failed to connect|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|fetch failed|timed ?out|timeout/i;

/**
 * Whether an error falls into the retryable set that may trigger a fallback.
 *
 * Decision order, matching what the AI SDK actually throws:
 * 1. `APICallError.isRetryable` — the SDK already classifies upstream
 *    rejections (quota/capacity/timeout are retryable; content-safety, auth
 *    and other 4xx are not). Network errors stay retryable regardless.
 * 2. Numeric status codes: 408, 409, 429, or >= 500.
 * 3. Explicit network-transport signals in the message (e.g. the SDK's
 *    "Cannot connect to API: connect ECONNRESET" from a maxRetries=0 call).
 *
 * Anything else — validation/auth 4xx without a retryable flag, unknown
 * non-AI errors, programming errors — is kept as-is so the fallback never hides
 * the real cause (a bad prompt or a mis-keyed provider would only reproduce
 * elsewhere).
 */
export function isRetryableLlmError(error: unknown): boolean {
  const err = unwrapRetryChain(error);
  if (!(err instanceof Error)) return false;

  if (APICallError.isInstance(err)) {
    // A transport failure is transient even if the flag is unset or false
    // (some providers wrap a TypeError as APICallError).
    if (NETWORK_ERROR_RE.test(err.message)) return true;
    if (typeof err.isRetryable === 'boolean') return err.isRetryable;
  }

  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') {
    return statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500;
  }

  return NETWORK_ERROR_RE.test(err.message);
}

/**
 * Whether a model output counts as "empty" for the fallback decision.
 *
 * Only genuinely empty (or whitespace-only) text triggers the fallback on the
 * validation path — a non-empty result that fails a caller-supplied validator
 * (format/JSON checks) must NOT spend the fallback model's quota on it. This
 * matches the PR contract: "empty output" is a retryable failure, "output
 * quality is off" is not.
 */
export function isEmptyLlmOutput(text: string | null | undefined): boolean {
  return !text || text.trim().length === 0;
}

/**
 * Single, shared retryable-failure decision for both call paths.
 *
 * - `error` set: retryable iff `isRetryableLlmError(error)`.
 * - `error` undefined (validation path): retryable iff the output is
 *   empty/whitespace-only (see `isEmptyLlmOutput`).
 */
export function shouldFallbackFor(error: unknown, text: string | null | undefined): boolean {
  if (error !== undefined) return isRetryableLlmError(error);
  return isEmptyLlmOutput(text);
}

/**
 * One log line per fired fallback, shared by callLLM and the outlines stream.
 *
 * Format: `[source] <reason> on <primary>; falling back once to <fallback>`
 */
export function logFallbackFired(
  source: string,
  reason: 'retryable failure' | 'empty output',
  primary: string,
  fallback: string,
): void {
  log.warn(`[${source}] ${reason} on ${primary}; falling back once to ${fallback}`);
}
