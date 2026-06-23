/**
 * Per-stage LLM model routing (issue #745).
 *
 * Optional, config-only overrides that map a generation *stage* to a specific
 * model string. Consulted during model resolution and falling back to today's
 * behavior (`DEFAULT_MODEL`) when unset — zero behavior change unless opted in.
 *
 * Surface: a single JSON env var `MODEL_ROUTES`. Each value is a model string in
 * the canonical `provider:model` format (see parseModelString), OR an object
 * `{model, thinking}` where `thinking` is the full ThinkingConfig abstraction
 * (mode/effort/level/enabled/budgetTokens/excludeReasoningOutput) — normalized
 * per the model's capability by callLLM. e.g.
 *
 *   DEFAULT_MODEL=openai:gpt-5.4-mini
 *   MODEL_ROUTES='{"scene-content":"openai:gpt-5.4","pbl-chat":{"model":"anthropic:claude-sonnet-4","thinking":{"enabled":false}}}'
 *
 * Only the *routable* stages below are valid keys — each is backed by a real
 * `resolveModel` call site. Downstream sub-calls (e.g. `pbl-generate`,
 * `chat-adapter-stream`) inherit their parent stage's resolved model.
 */

import { createLogger } from '@/lib/logger';
import type {
  ThinkingConfig,
  ThinkingEffort,
  ThinkingLevel,
  ThinkingMode,
} from '@/lib/types/provider';

const log = createLogger('model-routes');

const VALID_MODES: readonly ThinkingMode[] = ['default', 'disabled', 'enabled', 'auto'];
const VALID_EFFORTS: readonly ThinkingEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const VALID_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

/** A resolved route entry: the model string plus an optional full thinking config. */
export interface StageRoute {
  model: string;
  /**
   * Full thinking config for this stage (the unified ThinkingConfig abstraction:
   * mode / effort / level / enabled / budgetTokens / excludeReasoningOutput).
   * Passed through to callLLM, which normalizes it against the model's capability.
   */
  thinking?: ThinkingConfig;
}

/** Validate/sanitize a route's `thinking` object into a ThinkingConfig (drops bad fields with a warn). */
function parseThinking(key: string, raw: unknown): ThinkingConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn(`"thinking" for stage "${key}" must be an object in MODEL_ROUTES; ignored.`);
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const out: ThinkingConfig = {};
  const checkEnum = <T>(field: string, val: unknown, valid: readonly T[]): T | undefined => {
    if (val === undefined) return undefined;
    if (typeof val === 'string' && (valid as readonly string[]).includes(val)) return val as T;
    log.warn(
      `Invalid ${field} "${String(val)}" for stage "${key}" ignored. Valid: ${valid.join(', ')}`,
    );
    return undefined;
  };
  const mode = checkEnum<ThinkingMode>('mode', o.mode, VALID_MODES);
  if (mode) out.mode = mode;
  const effort = checkEnum<ThinkingEffort>('effort', o.effort, VALID_EFFORTS);
  if (effort) out.effort = effort;
  const level = checkEnum<ThinkingLevel>('level', o.level, VALID_LEVELS);
  if (level) out.level = level;
  if (o.enabled !== undefined) {
    if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
    else
      log.warn(
        `Invalid enabled "${String(o.enabled)}" for stage "${key}" ignored (must be boolean).`,
      );
  }
  if (o.budgetTokens !== undefined) {
    if (typeof o.budgetTokens === 'number') out.budgetTokens = o.budgetTokens;
    else
      log.warn(
        `Invalid budgetTokens "${String(o.budgetTokens)}" for stage "${key}" ignored (must be number).`,
      );
  }
  if (o.excludeReasoningOutput !== undefined) {
    if (typeof o.excludeReasoningOutput === 'boolean')
      out.excludeReasoningOutput = o.excludeReasoningOutput;
    else log.warn(`Invalid excludeReasoningOutput for stage "${key}" ignored (must be boolean).`);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Stages that can be independently routed to a model. Each value is a valid
 * `MODEL_ROUTES` key; the base entries also mirror a `callLLM` source label.
 *
 * `scene-content:<type>` are finer-grained composite keys: when a scene-content
 * request carries an `outline.type`, it routes via the composite key and falls
 * back to the base `scene-content` route (see getStageModel). Only the four
 * core scene types are routable; interactive widget sub-types are not split.
 */
export const LLM_STAGES = [
  'scene-outlines-stream',
  'scene-content',
  'scene-content:slide',
  'scene-content:quiz',
  'scene-content:interactive',
  'scene-content:pbl',
  'scene-actions',
  'agent-profiles',
  'quiz-grade',
  'pbl-chat',
  'chat-adapter',
  'generate-classroom',
  'web-search-query-rewrite',
  'maic-agent',
] as const;

export type LlmStage = (typeof LLM_STAGES)[number];

/** Parsed once per process (env is read at startup; tests reset via vi.resetModules). */
let _routes: Record<string, StageRoute> | null = null;

/** Parse one MODEL_ROUTES value (string model, or {model, thinking}) into a StageRoute. */
function parseRouteValue(key: string, value: unknown): StageRoute | undefined {
  if (typeof value === 'string') {
    return value.trim() ? { model: value.trim() } : undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const model = typeof obj.model === 'string' ? obj.model.trim() : '';
    if (!model) {
      log.warn(`Route for stage "${key}" has no model string in MODEL_ROUTES; ignored.`);
      return undefined;
    }
    const route: StageRoute = { model };
    if (obj.thinking !== undefined) {
      const thinking = parseThinking(key, obj.thinking);
      if (thinking) route.thinking = thinking;
    }
    return route;
  }
  log.warn(`Invalid route value for stage "${key}" in MODEL_ROUTES ignored.`);
  return undefined;
}

function loadRoutes(): Record<string, StageRoute> {
  if (_routes) return _routes;

  const routes: Record<string, StageRoute> = {};
  const raw = process.env.MODEL_ROUTES?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!(LLM_STAGES as readonly string[]).includes(key)) {
            log.warn(
              `Unknown stage "${key}" in MODEL_ROUTES ignored. Valid stages: ${LLM_STAGES.join(', ')}`,
            );
            continue;
          }
          const route = parseRouteValue(key, value);
          if (route) routes[key] = route;
        }
      } else {
        log.error('MODEL_ROUTES must be a JSON object of stage -> model; ignoring.');
      }
    } catch (err) {
      log.error('Invalid MODEL_ROUTES JSON, ignoring (falling back to DEFAULT_MODEL).', err);
    }
  }

  _routes = routes;
  return _routes;
}

/**
 * Resolve the configured model string for a stage, or `undefined` when the
 * stage is unset/unconfigured (callers fall back to `DEFAULT_MODEL`).
 *
 * Composite `a:b` stages resolve most-specific-first: the full key is tried,
 * then successively shorter prefixes (e.g. `scene-content:quiz` →
 * `scene-content`). Plain stages (no colon) are a single exact lookup.
 */
export function getStageRoute(stage?: string): StageRoute | undefined {
  if (!stage) return undefined;
  const routes = loadRoutes();
  let key: string | undefined = stage;
  while (key) {
    const route = routes[key];
    if (route) return route;
    const lastColon = key.lastIndexOf(':');
    key = lastColon > 0 ? key.slice(0, lastColon) : undefined;
  }
  return undefined;
}

/** Convenience: the resolved model string for a stage (route's `model`). */
export function getStageModel(stage?: string): string | undefined {
  return getStageRoute(stage)?.model;
}
