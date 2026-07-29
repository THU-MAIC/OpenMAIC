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
 *  1. The original justification is still live, but narrower than it reads. It
 *     said: "the instructing turn forces `begin_turn` via `tool_choice`, which
 *     several providers reject when thinking is on — DeepSeek returns 400
 *     'Thinking mode does not support this tool_choice'". `begin_turn` is gone
 *     and the instructing turn now passes `tools` + `stopWhen`, forcing nothing,
 *     so it is tempting to conclude the wall is gone with it. It is not.
 *     Probed against the live DeepSeek V4 Pro API with this turn's exact shape:
 *       - thinking on + `tools` + `stopWhen`  → streams fine, 66 reasoning tokens
 *       - thinking on + forced `toolChoice`   → still that exact 400
 *     So the incompatibility is bound to a FORCED tool choice, not to tools in
 *     general. Today's turns do not reach it, but anyone who reintroduces a
 *     forced tool choice here will — which is a second reason to keep the policy
 *     rather than delete it as dead weight.
 *     Latency is the third: on the same probe the teaching-turn shape reached
 *     its first token in 1.4 s with thinking off against 3.0 s with DeepSeek's
 *     default thinking on. The teaching turns gain nothing from thinking, and
 *     the instructor is the chattiest surface in the product.
 *  2. The simulator does NOT apply this policy, and did not before either. Its
 *     turns therefore honour a per-request / stage-route `thinkingConfig` where
 *     the teaching turns override it. That divergence is pre-existing and
 *     deliberate here; unifying it is a product decision, not a refactor.
 *  3. On native adapters this constant is currently a no-op whenever a thinking
 *     config does arrive: the teaching turns pass their own `providerOptions`
 *     built from that config, and `injectProviderOptions` yields to a
 *     caller-set `providerOptions`. So a stage route that sets
 *     `thinking: { mode: 'enabled' }` on an OpenAI / Anthropic / Google model
 *     gets thinking ON, policy notwithstanding; the constant governs only the
 *     OpenAI-compatible path there (via the thinking context) plus the
 *     no-incoming-config case. Pre-existing, and left as-is so this stays a
 *     refactor — but the code reads more absolute than it behaves.
 *  4. "Disabled" is resolved against each model's catalogued capability, and
 *     for some models that resolution is not "off". Measured against the
 *     current catalog: `claude-sonnet-5` → `thinking: disabled`,
 *     `gemini-2.5-flash` → `thinkingBudget: 0`, `gpt-5.4` → `effort: none` —
 *     but `gpt-5.4-pro` → `effort: medium` (its capability offers no
 *     none/minimal/low, so `pickThinkingEffort` falls back to the default),
 *     `gemini-2.5-pro` → `thinkingBudget: -1`, i.e. DYNAMIC thinking (its
 *     budget range carries no `disableValue`), and `claude-fable-5` →
 *     `thinking: adaptive, effort: low` (`toggleable: false`). Those three
 *     currently match the model's own default, so nothing changes in practice
 *     today — but a route pinned to one of them is not getting the policy this
 *     constant's name promises.
 */
export const PBL_V2_TEACHING_THINKING: ThinkingConfig = { mode: 'disabled', enabled: false };
