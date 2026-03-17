/**
 * Unified LLM Call Layer
 *
 * All LLM interactions should go through callLLM / streamLLM.
 */

import { generateText, streamText } from 'ai';
import type { GenerateTextResult, StreamTextResult } from 'ai';
import { createLogger } from '@/lib/logger';
import { PROVIDERS } from './providers';
import { thinkingContext } from './thinking-context';
import type { ProviderType, ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
const log = createLogger('LLM');

// Re-export for external use
export type { ThinkingConfig } from '@/lib/types/provider';

// Re-export the parameter types accepted by AI SDK
type GenerateTextParams = Parameters<typeof generateText>[0];
type StreamTextParams = Parameters<typeof streamText>[0];

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
// Currently handles: openai (native), anthropic (native), google (native).
// OpenAI-compatible providers (DeepSeek, Qwen, Kimi, GLM, etc.) are NOT
// handled — their vendor-specific thinking params can't be reliably passed
// through Vercel AI SDK's createOpenAI.
// ---------------------------------------------------------------------------

interface ModelThinkingInfo {
  providerType: ProviderType;
  thinking?: ThinkingCapability;
}

/** Model ID → provider type + thinking capability (built once at module load) */
const MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      map.set(model.id, {
        providerType: provider.type,
        thinking: model.capabilities?.thinking,
      });
    }
  }
  return map;
})();

/** Global thinking override from environment variable */
function getGlobalThinkingConfig(): ThinkingConfig | undefined {
  if (process.env.LLM_THINKING_DISABLED === 'true') {
    return { enabled: false };
  }
  return undefined;
}

type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Build providerOptions to disable thinking, using the lowest possible
 * intensity for models that cannot be fully turned off.
 */
function buildDisableThinking(
  modelId: string,
  providerType: ProviderType,
  _thinking: ThinkingCapability,
): ProviderOptions | undefined {
  switch (providerType) {
    case 'openai': {
      // GPT-5.1/5.2: support effort=none (fully off)
      // GPT-5/mini/nano: lowest is minimal
      // o-series: lowest is low
      let effort: string;
      if (modelId.startsWith('gpt-5.')) {
        effort = 'none';
      } else if (modelId.startsWith('gpt-5')) {
        effort = 'minimal';
      } else if (modelId.startsWith('o')) {
        effort = 'low';
      } else {
        // Non-thinking OpenAI models (gpt-4o etc.) — no injection needed
        return undefined;
      }
      if (!_thinking.toggleable && effort !== 'none') {
        log.info(
          `[thinking-adapter] Model ${modelId} cannot fully disable thinking, using effort=${effort}`,
        );
      }
      return { openai: { reasoningEffort: effort } };
    }

    case 'anthropic':
      // All Claude models support type=disabled
      return { anthropic: { thinking: { type: 'disabled' } } };

    case 'google': {
      // Gemini 3.x: uses thinkingLevel (cannot fully disable)
      // Gemini 2.5 Flash/Flash-Lite: uses thinkingBudget=0 (fully off)
      // Gemini 2.5 Pro: minimum thinkingBudget=128 (cannot fully disable)
      if (modelId.startsWith('gemini-3')) {
        const level = modelId.includes('flash') ? 'minimal' : 'low';
        log.info(
          `[thinking-adapter] Model ${modelId} cannot fully disable thinking, using thinkingLevel=${level}`,
        );
        return { google: { thinkingConfig: { thinkingLevel: level } } };
      }
      if (modelId === 'gemini-2.5-pro') {
        log.info(
          `[thinking-adapter] Model ${modelId} cannot fully disable thinking, using thinkingBudget=128`,
        );
        return { google: { thinkingConfig: { thinkingBudget: 128 } } };
      }
      // gemini-2.5-flash / flash-lite: can fully disable
      return { google: { thinkingConfig: { thinkingBudget: 0 } } };
    }

    default:
      return undefined;
  }
}

/**
 * Build providerOptions to enable thinking, optionally with a budget hint.
 */
function buildEnableThinking(
  modelId: string,
  providerType: ProviderType,
  _thinking: ThinkingCapability,
  budgetTokens?: number,
): ProviderOptions | undefined {
  switch (providerType) {
    case 'openai':
      // OpenAI uses discrete effort levels, no token-based budget.
      // Don't inject anything — let the model use its default effort.
      return undefined;

    case 'anthropic': {
      // 4.6 models: prefer adaptive (model decides depth automatically)
      // 4.5 models: require explicit budget
      if (modelId.includes('4-6')) {
        if (budgetTokens !== undefined) {
          return { anthropic: { thinking: { type: 'enabled', budgetTokens } } };
        }
        return { anthropic: { thinking: { type: 'adaptive' } } };
      }
      // Sonnet 4.5 / Haiku 4.5: must use enabled + budgetTokens
      const budget = budgetTokens ?? 10240; // sensible default
      return {
        anthropic: {
          thinking: { type: 'enabled', budgetTokens: Math.max(1024, budget) },
        },
      };
    }

    case 'google': {
      // Gemini 3.x: uses thinkingLevel (no numeric budget)
      if (modelId.startsWith('gemini-3')) {
        return { google: { thinkingConfig: { thinkingLevel: 'high' } } };
      }
      // Gemini 2.5: uses thinkingBudget
      if (budgetTokens !== undefined) {
        const min = modelId === 'gemini-2.5-pro' ? 128 : 0;
        return {
          google: {
            thinkingConfig: {
              thinkingBudget: Math.max(min, Math.min(24576, budgetTokens)),
            },
          },
        };
      }
      // No budget specified — let model use dynamic default
      return undefined;
    }

    default:
      return undefined;
  }
}

/**
 * Map a unified ThinkingConfig to provider-specific providerOptions.
 */
function buildThinkingProviderOptions(
  modelId: string,
  config: ThinkingConfig,
): ProviderOptions | undefined {
  const info = MODEL_THINKING_MAP.get(modelId);
  if (!info?.thinking) return undefined; // model has no thinking capability

  if (config.enabled === undefined) return undefined; // use model default

  if (config.enabled === false) {
    return buildDisableThinking(modelId, info.providerType, info.thinking);
  }

  // enabled === true
  return buildEnableThinking(modelId, info.providerType, info.thinking, config.budgetTokens);
}

/**
 * Default providerOptions for specific models (fallback when no ThinkingConfig is provided).
 * Gemini 3.x models use thinkingLevel instead of thinkingBudget.
 */
function getDefaultProviderOptions(modelId: string): ProviderOptions | undefined {
  if (modelId === 'gemini-3.1-pro-preview') {
    return { google: { thinkingConfig: { thinkingLevel: 'high' } } };
  }
  return undefined;
}

/**
 * Inject provider-specific thinking options into LLM call params.
 *
 * For native providers (OpenAI/Anthropic/Google), this sets providerOptions.
 * For OpenAI-compatible providers, providerOptions won't work (stripped by
 * zod schema) — those are handled by the custom fetch wrapper via thinkingContext.
 *
 * Priority: caller's providerOptions > ThinkingConfig > model defaults
 */
function injectProviderOptions<T extends GenerateTextParams | StreamTextParams>(
  params: T,
  thinking?: ThinkingConfig,
): T {
  if ((params as Record<string, unknown>).providerOptions) return params; // caller explicitly set providerOptions

  const modelId = getModelId(params);

  if (thinking) {
    const opts = buildThinkingProviderOptions(modelId, thinking);
    if (opts) return { ...params, providerOptions: opts };
  }

  // No thinking config — use model defaults (backward compat)
  const defaults = getDefaultProviderOptions(modelId);
  if (defaults) return { ...params, providerOptions: defaults };

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

/**
 * Unified wrapper around `generateText`.
 *
 * @param params - Same parameters as AI SDK's `generateText`
 * @param source - A short label for log grouping (e.g. 'scene-stream', 'pbl-chat')
 * @param retryOptions - Optional retry-on-validation-failure settings
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export async function callLLM<T extends GenerateTextParams>(
  params: T,
  source: string,
  retryOptions?: LLMRetryOptions,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<GenerateTextResult<any, any>> {
  const maxAttempts = (retryOptions?.retries ?? 0) + 1;
  const validate = retryOptions?.validate ?? (maxAttempts > 1 ? DEFAULT_VALIDATE : undefined);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastResult: GenerateTextResult<any, any> | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Resolve effective thinking config: per-call > global env > undefined
      const effectiveThinking = thinking ?? getGlobalThinkingConfig();
      const injectedParams = injectProviderOptions(params, effectiveThinking);

      // Wrap in thinkingContext so the custom fetch wrapper in providers.ts
      // can read the config and inject vendor-specific body params for
      // OpenAI-compatible providers.
      const result = await thinkingContext.run(effectiveThinking, () =>
        generateText(injectedParams),
      );

      // Validate result (only when retries are configured)
      if (validate && !validate(result.text)) {
        log.warn(
          `[${source}] Validation failed (attempt ${attempt}/${maxAttempts}), ${attempt < maxAttempts ? 'retrying...' : 'giving up'}`,
        );
        lastResult = result;
        continue;
      }

      return result;
    } catch (error) {
      lastError = error;

      if (attempt < maxAttempts) {
        log.warn(`[${source}] Call failed (attempt ${attempt}/${maxAttempts}), retrying...`, error);
        continue;
      }
    }
  }

  // All attempts exhausted — return last result or throw last error
  if (lastResult) return lastResult;
  throw lastError;
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
  const injectedParams = injectProviderOptions(params, effectiveThinking);
  const result = thinkingContext.run(effectiveThinking, () => streamText(injectedParams));

  return result;
}
