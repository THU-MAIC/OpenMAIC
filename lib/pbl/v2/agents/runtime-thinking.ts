import { thinkingContext } from '@/lib/ai/thinking-context';
import type { ThinkingConfig } from '@/lib/types/provider';

/**
 * PBL v2 runtime LLM calls force-disable thinking.
 *
 * The instructing turn forces `begin_turn` via `tool_choice`, which several
 * providers reject when thinking is on — DeepSeek returns 400 "Thinking mode
 * does not support this tool_choice". We never intentionally enabled thinking
 * on these turns (the PBL v2 client sends no `thinkingConfig`); some pinned
 * models just default it on. Disabling it removes the incompatibility without
 * losing any behavior we relied on.
 *
 * For OpenAI-compatible providers (e.g. DeepSeek) thinking is injected by the
 * fetch wrapper in `providers.ts`, which reads the per-request config from the
 * `thinkingContext` AsyncLocalStorage. The agents call the AI SDK directly
 * (not via `callLLM`/`streamLLM`), so nothing seeds that store — we do it here.
 * The SDK call must be started INSIDE `run` (its consumption can be outside) so
 * the lazily-issued fetch inherits the context, matching `streamLLM`.
 *
 * Scope: PBL v2 runtime only (instructor / evaluator). Generation (planner) is
 * intentionally untouched.
 */
const PBL_V2_THINKING_DISABLED: ThinkingConfig = { mode: 'disabled', enabled: false };

export function withThinkingDisabled<T>(startCall: () => T): T {
  return thinkingContext.run(PBL_V2_THINKING_DISABLED, startCall);
}
