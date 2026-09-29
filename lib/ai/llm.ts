/**
 * Unified LLM Call Layer
 *
 * All LLM interactions should go through callLLM / streamLLM.
 */

import { generateText, streamText } from 'ai';
import type { GenerateTextResult, JSONValue, LanguageModel, StreamTextResult } from 'ai';
import { createLogger } from '@/lib/logger';
import { PROVIDERS } from './providers';
import { thinkingContext } from './thinking-context';
import { isEmptyLlmOutput, shouldFallbackFor, logFallbackFired } from '@/lib/server/llm-fallback';
import { getModelMetadataKey } from './model-metadata';
import { getCanonicalModelId } from './model-aliases';
import type { ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
import {
  getThinkingMode,
  pickThinkingBudget,
  pickThinkingEffort,
  pickThinkingLevel,
} from '@/lib/ai/thinking-config';
const log = createLogger('LLM');

// Re-export for external use
export type { ThinkingConfig } from '@/lib/types/provider';

// Re-export the parameter types accepted by AI SDK
type GenerateTextParams = Parameters<typeof generateText>[0];
export type StreamTextParams = Parameters<typeof streamText>[0];

function _extractRequestInfo(params: GenerateTextParams | StreamTextParams) {
  const tools = params.tools ? Object.keys(params.tools as Record<string, unknown>) : undefined;

  const p = params as Record<string, unknown>;
  return {
    system: p.system as string | undefined,
    prompt: p.prompt as string | undefined,
    messages: p.messages as unknown[] | undefined,
    tools,
    maxOutputTokens: p.maxOutputTokens as number | undefined,
  };
}

function getModelId(params: GenerateTextParams | StreamTextParams): string {
  const m = params.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'modelId' in m) return (m as { modelId: string }).modelId;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Thinking / Reasoning Adapter
//
// Builds a lookup table from PROVIDERS at module load time, then uses it to
// map a unified ThinkingConfig into provider-specific providerOptions.
// Native providers (OpenAI/Anthropic/Google) are mapped to providerOptions.
// OpenAI-compatible providers are injected by the providers.ts fetch wrapper.
// ---------------------------------------------------------------------------

interface ModelThinkingInfo {
  thinking?: ThinkingCapability;
}

/** Provider/model → thinking capability (built once at module load) */
const MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      map.set(getModelMetadataKey(provider.id, model.id), {
        thinking: model.capabilities?.thinking,
      });
    }
  }
  return map;
})();

/** Model ID → thinking capability for IDs that are unique across providers. */
const UNIQUE_MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const counts = new Map<string, number>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
    }
  }

  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      if (counts.get(model.id) === 1) {
        map.set(model.id, {
          thinking: model.capabilities?.thinking,
        });
      }
    }
  }
  return map;
})();

/** Global thinking override from environment variable */
function getGlobalThinkingConfig(): ThinkingConfig | undefined {
  if (process.env.LLM_THINKING_DISABLED === 'true') {
    return { mode: 'disabled', enabled: false };
  }
  return undefined;
}

type ProviderOptions = Record<string, Record<string, JSONValue | undefined>>;

function getAnthropicEffort(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const effort = pickThinkingEffort(thinking, config);
  if (!effort || effort === 'none' || effort === 'minimal') return undefined;
  return effort;
}

function normalizeProviderId(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  if (provider === 'anthropic.messages' && modelId?.startsWith('MiniMax-')) return 'minimax';
  if (provider === 'amazon-bedrock') return 'bedrock';
  if (provider in PROVIDERS) return provider;
  const prefix = provider.split('.')[0];
  return prefix in PROVIDERS ? prefix : undefined;
}

function getModelProviderId(params: GenerateTextParams | StreamTextParams): string | undefined {
  const m = params.model;
  if (!m || typeof m !== 'object' || !('provider' in m)) return undefined;
  const provider = (m as { provider?: string }).provider;
  const modelId = 'modelId' in m ? (m as { modelId?: string }).modelId : undefined;
  return normalizeProviderId(provider, modelId);
}

/**
 * Map a unified ThinkingConfig to provider-specific providerOptions.
 */
function buildThinkingProviderOptions(
  providerId: string | undefined,
  modelId: string,
  config: ThinkingConfig,
): ProviderOptions | undefined {
  const lookupModelId = providerId ? getCanonicalModelId(providerId, modelId) : modelId;
  const info = providerId
    ? MODEL_THINKING_MAP.get(getModelMetadataKey(providerId, lookupModelId))
    : UNIQUE_MODEL_THINKING_MAP.get(lookupModelId);
  if (!info?.thinking) return undefined; // model has no thinking capability
  const thinking = info.thinking;
  if (thinking.control === 'none') return undefined;

  const mode = getThinkingMode(config);

  switch (thinking.requestAdapter) {
    case 'openai': {
      const effort = pickThinkingEffort(thinking, config);
      return effort ? { openai: { reasoningEffort: effort } } : undefined;
    }

    case 'anthropic': {
      const buildAnthropicOptions = (
        options: Record<string, JSONValue | undefined>,
      ): ProviderOptions => ({
        anthropic: options,
      });

      if (mode === 'disabled' && thinking.toggleable !== false) {
        return buildAnthropicOptions({ thinking: { type: 'disabled' } });
      }

      if (thinking.control === 'toggle-budget' || thinking.control === 'budget-only') {
        const budget = pickThinkingBudget(thinking, config);
        return budget === undefined
          ? undefined
          : buildAnthropicOptions({ thinking: { type: 'enabled', budgetTokens: budget } });
      }

      const effort = getAnthropicEffort(thinking, config);
      if (!effort) return undefined;

      if (thinking.anthropicThinking?.type === 'adaptive') {
        return buildAnthropicOptions({
          thinking: { type: 'adaptive' },
          effort,
        });
      }

      const manualEffort = effort === 'xhigh' ? 'max' : effort;
      const budget = thinking.anthropicThinking?.budgetByEffort?.[manualEffort];
      if (!budget) return undefined;
      return buildAnthropicOptions({
        thinking: { type: 'enabled', budgetTokens: budget },
        effort: manualEffort,
      });
    }

    case 'google': {
      if (thinking.control === 'level') {
        const level = pickThinkingLevel(thinking, config);
        return level ? { google: { thinkingConfig: { thinkingLevel: level } } } : undefined;
      }

      const budget = pickThinkingBudget(thinking, config);
      if (budget === undefined) return undefined;
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    }

    default:
      // OpenAI-compatible providers are injected in providers.ts fetch wrapper.
      return undefined;
  }
}

/**
 * Resolve providerOptions the way callLLM / streamLLM resolve them internally.
 *
 * There are no production callers left: every server-side call goes through the
 * wrappers (a lint rule enforces it), and they inject provider options
 * themselves. Kept exported because it is the only way to inspect that mapping
 * from the outside, which the SDK-integration tests do.
 */
export function resolveThinkingProviderOptions(
  model: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): ProviderOptions | undefined {
  if (!thinkingConfig) return undefined;
  if (typeof model !== 'object' || !('modelId' in model)) return undefined;
  const modelId = (model as { modelId?: string }).modelId ?? 'unknown';
  const provider = 'provider' in model ? (model as { provider?: string }).provider : undefined;
  return buildThinkingProviderOptions(
    normalizeProviderId(provider, modelId),
    modelId,
    thinkingConfig,
  );
}

/**
 * Inject provider-specific thinking options into LLM call params.
 *
 * For native providers (OpenAI/Anthropic/Google), this sets providerOptions.
 * For OpenAI-compatible providers, providerOptions won't work (stripped by
 * zod schema) — those are handled by the custom fetch wrapper via thinkingContext.
 *
 * Priority: caller's providerOptions > ThinkingConfig
 */
function injectProviderOptions<T extends GenerateTextParams | StreamTextParams>(
  params: T,
  thinking?: ThinkingConfig,
): T {
  if ((params as Record<string, unknown>).providerOptions) return params; // caller explicitly set providerOptions

  const modelId = getModelId(params);
  const providerId = getModelProviderId(params);

  if (thinking) {
    const opts = buildThinkingProviderOptions(providerId, modelId, thinking);
    if (opts) return { ...params, providerOptions: opts };
  }

  return params;
}

/**
 * Options for LLM call retry on validation failure.
 * This is separate from the AI SDK's built-in maxRetries (which handles network/5xx errors).
 */
export interface LLMRetryOptions {
  /** Max retry attempts when validate() fails or the response is empty (default: 0 = no retry) */
  retries?: number;
  /** Custom validation function. Return true to accept the result, false to retry.
   *  Default: checks that response text is non-empty. */
  validate?: (text: string) => boolean;
}

const DEFAULT_VALIDATE = (text: string) => text.trim().length > 0;

// ---------------------------------------------------------------------------
// Usage capture
//
// Every server-side LLM call funnels through callLLM/streamLLM, so usage is
// recorded here in one place. Fire-and-forget: failures never affect generation.
// The fs-backed storage is imported dynamically so llm.ts stays safe to bundle
// wherever it's transitively imported.
// ---------------------------------------------------------------------------

function buildUsageMeta(params: GenerateTextParams | StreamTextParams, source: string) {
  const rawModelId = getModelId(params);
  const providerId = getModelProviderId(params) ?? 'unknown';
  const modelId = getCanonicalModelId(providerId, rawModelId);
  return { source, providerId, modelId, modelString: `${providerId}:${modelId}` };
}

/** Record one call's usage. Never throws. */
function recordUsageSafe(
  rawUsage: unknown,
  meta: { source: string; providerId: string; modelId: string; modelString: string },
): void {
  void (async () => {
    try {
      const { normalizeUsage } = await import('@/lib/usage/normalize');
      const { recordUsage } = await import('@/lib/server/usage-storage');
      await recordUsage({
        kind: 'llm',
        source: meta.source,
        providerId: meta.providerId,
        modelId: meta.modelId,
        modelString: meta.modelString,
        usage: normalizeUsage(rawUsage as never),
      });
    } catch (err) {
      log.warn('Usage capture failed (ignored):', err);
    }
  })();
}

/**
 * Unified wrapper around `generateText`.
 *
 * @param params - Same parameters as AI SDK's `generateText`
 * @param source - A short label for log grouping (e.g. 'scene-stream', 'pbl-chat')
 * @param retryOptions - Optional retry-on-validation-failure settings
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 * @param fallbackOptions - Optional knobs. `{ enabled: false }` skips the
 *   retryable-failure model fallback for this call (e.g. verify-model).
 *   `serverManaged: true` must be passed (from resolveModel's stamp of the
 *   same name) for the fallback to arm at all: it only protects primaries the
 *   server resolved, never a client-supplied model.
 */
export async function callLLM<T extends GenerateTextParams>(
  params: T,
  source: string,
  retryOptions?: LLMRetryOptions,
  thinking?: ThinkingConfig,
  fallbackOptions?: { enabled?: boolean; serverManaged?: boolean },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<GenerateTextResult<any, any>> {
  const maxAttempts = (retryOptions?.retries ?? 0) + 1;
  const validate = retryOptions?.validate ?? (maxAttempts > 1 ? DEFAULT_VALIDATE : undefined);
  // The fallback only protects primaries the SERVER resolved (a routed stage
  // or a server-configured provider). resolveModel stamps `serverManaged` on
  // its result and every production caller passes it through here; a
  // client-supplied model (x-model with a garbage key) must never be allowed
  // to burn the operator's fallback key, so an absent stamp means NOT armed.
  // verify-model additionally probes the exact primary model, so it never
  // falls back either.
  const allowFallback =
    fallbackOptions?.enabled !== false &&
    fallbackOptions?.serverManaged === true &&
    source !== 'verify-model';
  // Resolve the fallback once up front. The empty-output safety net below only
  // arms when a fallback model is actually configured; without this gate an
  // empty result would flip from success to failure for operators who never
  // set MODEL_FALLBACK or a MODEL_ROUTES fallback.
  const fallback = allowFallback ? await resolveFallbackModelSafe(source) : null;

  /** One generateText round for the given params; validates when asked to. */
  async function runRound(
    roundParams: T,
    attemptLabel: string,
  ): Promise<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { ok: true; result: GenerateTextResult<any, any> }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { ok: false; error: unknown; result?: GenerateTextResult<any, any>; finishReason?: string }
  > {
    try {
      const effectiveThinking = thinking ?? getGlobalThinkingConfig();
      const injectedParams = injectProviderOptions(roundParams, effectiveThinking);

      // Wrap in thinkingContext so the custom fetch wrapper in providers.ts
      // can read the config and inject vendor-specific body params for
      // OpenAI-compatible providers.
      const result = await thinkingContext.run(effectiveThinking, () =>
        generateText(injectedParams),
      );

      // Record before validating: every attempt that got this far was billed,
      // including one that fails validation below and one that is handed back
      // after the retries are exhausted. Recording on the success path only
      // would drop both.
      //
      // `usage` is the LAST step only; on a multi-step tool run (`stopWhen`)
      // every earlier step would go unaccounted. `totalUsage` aggregates across
      // steps and equals `usage` for a single-step call. Mirrors streamLLM,
      // which already prefers the aggregate.
      recordUsageSafe(result.totalUsage ?? result.usage, buildUsageMeta(injectedParams, source));

      // A content-filter finish (e.g. a Gemini SAFETY block) is a refusal, not
      // a transient failure: retrying it on another model reproduces the
      // refusal, so it must never reach the fallback decision — even when the
      // refusal comes back with empty text (which would otherwise look exactly
      // like an empty output).
      if (result.finishReason === 'content-filter') {
        log.warn(`[${source}] Content-filter finish (${attemptLabel})`);
        return { ok: false, error: undefined, result, finishReason: 'content-filter' };
      }

      // Empty-output detection arms by default when a fallback model is
      // configured and no caller-supplied validator is in play: an empty
      // result that used to return as success now gets one fallback attempt.
      // Non-empty results still succeed exactly as before — "output quality
      // is off" is never a fallback trigger.
      const emptyAsFailure = fallback !== null && !validate && isEmptyLlmOutput(result.text);
      if (emptyAsFailure || (validate && !validate(result.text))) {
        log.warn(
          `[${source}] ${emptyAsFailure ? 'Empty output' : 'Validation failed'} (${attemptLabel})`,
        );
        return { ok: false, error: undefined, result };
      }
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error };
    }
  }

  // Phase 1 — primary model, up to maxAttempts times (existing behaviour).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastResult: GenerateTextResult<any, any> | undefined;
  let lastError: unknown;
  let triggerFallback = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const round = await runRound(params, `attempt ${attempt}/${maxAttempts}`);
    if (round.ok) return round.result;
    if (round.error !== undefined) {
      lastError = round.error;
      if (attempt < maxAttempts) {
        log.warn(
          `[${source}] Call failed (attempt ${attempt}/${maxAttempts}), retrying...`,
          round.error,
        );
        continue;
      }
      if (allowFallback && shouldFallbackFor(round.error, undefined)) {
        triggerFallback = true;
      }
    } else {
      // Validation failure — keep the last billed result. The fallback is only
      // considered for genuinely empty/whitespace-only output, never for a
      // non-empty result that fails a caller-supplied validator (that would
      // spend the fallback model's quota on "output quality is off").
      lastResult = round.result;
      // A content-filter finish is a refusal: retrying the same model cannot
      // change the outcome, so stop the primary loop here. It is already
      // excluded from the fallback decision below.
      if (round.finishReason === 'content-filter') break;
      // Content-filter refusals never reach the fallback decision — even when
      // the refusal came back with empty text (a SAFETY block looks exactly
      // like an empty output otherwise).
      if (attempt >= maxAttempts && fallback !== null && round.finishReason !== 'content-filter') {
        if (shouldFallbackFor(undefined, round.result?.text)) triggerFallback = true;
      }
    }
  }

  // Phase 2 — fallback model, exactly one round (no further escalation).
  if (triggerFallback) {
    if (fallback) {
      const primary = typeof params.model === 'string' ? params.model : getModelId(params);
      logFallbackFired(
        source,
        lastError !== undefined ? 'retryable failure' : 'empty output',
        primary || '?',
        fallback.modelString,
      );
      // The fallback round is the LAST attempt: run it with no SDK-internal
      // retries on top (a 503 on both models must not cost 3+3 upstream
      // calls), and do not reuse the caller's abort signal — an
      // AbortSignal.timeout that already fired would make the fallback round
      // impossible to run.
      const round = await runRound(
        { ...params, model: fallback.model, maxRetries: 0, abortSignal: undefined } as T,
        'fallback',
      );
      if (round.ok) return round.result;
      if (round.error !== undefined) lastError = round.error;
      else lastResult = round.result;
    }
    // No `else` branch for fallback === null: when no fallback is configured,
    // the armed-but-unavailable state is the normal steady case (MODEL_FALLBACK
    // unset) and the final failure below already reports it — a per-call warn
    // here would just be noise on every retryable exhaustion.
  }

  // All attempts exhausted — return last result or throw last error
  if (lastResult !== undefined) return lastResult;
  throw lastError;
}

/** Lazily resolve the fallback model; never throws (fallback is best-effort). */
async function resolveFallbackModelSafe(
  source: string,
): Promise<{ model: LanguageModel; modelString: string } | null> {
  try {
    const { resolveFallbackModel } = await import('@/lib/server/llm-fallback');
    return await resolveFallbackModel(source);
  } catch (err) {
    log.warn(`[${source}] Fallback model resolution failed, skipping fallback:`, err);
    return null;
  }
}

/**
 * Unified wrapper around `streamText`.
 *
 * Returns the same StreamTextResult.
 *
 * @param params - Same parameters as AI SDK's `streamText`
 * @param source - A short label for log grouping
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export function streamLLM<T extends StreamTextParams>(
  params: T,
  source: string,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): StreamTextResult<any, any> {
  // Resolve effective thinking config and wrap in thinkingContext
  const effectiveThinking = thinking ?? getGlobalThinkingConfig();

  // Wrap onFinish to capture usage when the stream completes, preserving any
  // caller-supplied onFinish. totalUsage aggregates across steps.
  const usageMeta = buildUsageMeta(params, source);
  const callerOnFinish = (params as Record<string, unknown>).onFinish as
    | ((event: { totalUsage?: unknown; usage?: unknown }) => void | Promise<void>)
    | undefined;
  const wrappedParams = {
    ...params,
    onFinish: async (event: { totalUsage?: unknown; usage?: unknown }) => {
      recordUsageSafe(event.totalUsage ?? event.usage, usageMeta);
      if (callerOnFinish) await callerOnFinish(event);
    },
  } as T;

  const injectedParams = injectProviderOptions(wrappedParams, effectiveThinking);
  const result = thinkingContext.run(effectiveThinking, () => streamText(injectedParams));

  return result;
}
