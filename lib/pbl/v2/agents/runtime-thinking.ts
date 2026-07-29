import type { ThinkingConfig } from '@/lib/types/provider';

/**
 * Thinking policy for the PBL v2 teaching turns (instructor / evaluator):
 * thinking is force-disabled. Generation (planner) is intentionally untouched,
 * and so is the simulator — see the caveats below.
 *
 * We never intentionally enabled thinking on these turns (the PBL v2 client
 * sends no `thinkingConfig`); some pinned models just default it on, and the
 * teaching turns gain nothing from it.
 *
 * This module used to also carry the *mechanism*: a `withThinkingDisabled`
 * helper that seeded the `thinkingContext` AsyncLocalStorage by hand, because
 * the agents called the AI SDK directly and nothing else seeded it. The agents
 * now go through `streamLLM` / `callLLM`, which take a `thinking` argument and
 * do the seeding (plus provider-option resolution) themselves — so only the
 * policy value is left here.
 *
 * Two caveats a future reader should know before treating this as settled:
 *
 *  1. The original justification has expired. It read: "the instructing turn
 *     forces `begin_turn` via `tool_choice`, which several providers reject when
 *     thinking is on — DeepSeek returns 400 'Thinking mode does not support this
 *     tool_choice'". `begin_turn` no longer exists, and the instructing turn now
 *     passes `tools` + `stopWhen` and forces nothing. If no provider still
 *     rejects these calls, the policy can be dropped outright rather than
 *     applied — it is kept only because the absence of a 400 is harder to
 *     confirm than its presence.
 *  2. The simulator does NOT apply this policy, and did not before either. Its
 *     turns therefore honour a per-request / stage-route `thinkingConfig` where
 *     the teaching turns override it. That divergence is pre-existing and
 *     deliberate here; unifying it is a product decision, not a refactor.
 */
export const PBL_V2_TEACHING_THINKING: ThinkingConfig = { mode: 'disabled', enabled: false };
