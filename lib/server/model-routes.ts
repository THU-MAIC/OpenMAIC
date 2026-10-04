/**
 * LLM stage keys and the browser's per-stage routes.
 *
 * A stage is a `callLLM` call site's label; each belongs to one capability
 * slot (lib/config/model-slots.ts), which decides its model (RFC #1701). The
 * operator's `MODEL_ROUTES` is gone: a deployment that still sets it without
 * openmaic.yml stops at startup (lib/server/model-config/deployment-layer.ts).
 *
 * What remains is the browser's own per-stage selection, sent as the
 * `x-model-routes` header and consulted, deprecated, only for a slot the
 * configuration leaves unassigned. Each value is a model string in the
 * canonical `provider:model` format (see parseModelString), or an object
 * `{model, thinking}` where `thinking` is the full ThinkingConfig abstraction
 * (mode/effort/level/enabled/budgetTokens/excludeReasoningOutput), normalized
 * per the model's capability by callLLM.
 */

import { createLogger } from '@/lib/logger';
import type {
  ThinkingConfig,
  ThinkingEffort,
  ThinkingLevel,
  ThinkingMode,
} from '@/lib/types/provider';

const log = createLogger('model-routes');

export const VALID_MODES: readonly ThinkingMode[] = ['default', 'disabled', 'enabled', 'auto'];
export const VALID_EFFORTS: readonly ThinkingEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
export const VALID_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high'];

/**
 * A route entry: the model string plus an optional full thinking config.
 *
 * `api`/`dialect`, `contextWindow` and `fallback` are parsed but not honored on
 * a user route: only `model` and `thinking` reach a call.
 */
export interface StageRoute {
  model: string;
  /**
   * Explicit pi transport dialect (for example openai-completions). Consumed only
   * by the agent-driver stage; inert on every other routable stage.
   */
  api?: string;
  /**
   * Effective context window for this stage, overriding the provider catalog
   * value. Consumed by pi-native compaction thresholds (e.g. the agent driver)
   * so an operator can pin a conservative window below the catalog number.
   * Consumed only by the agent-driver stage; inert on every other routable stage.
   */
  contextWindow?: number;
  /**
   * Full thinking config for this stage (the unified ThinkingConfig abstraction:
   * mode / effort / level / enabled / budgetTokens / excludeReasoningOutput).
   * Passed through to callLLM, which normalizes it against the model's capability.
   */
  thinking?: ThinkingConfig;
  /** Parsed, and dropped from user routes: retries follow the slot's fallback. */
  fallback?: string;
}

/** Validate/sanitize a route's `thinking` object into a ThinkingConfig (drops bad fields with a warn). */
function parseThinking(key: string, raw: unknown): ThinkingConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    log.warn(`"thinking" for stage "${key}" must be an object in x-model-routes; ignored.`);
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
 * The LLM stage keys. Each maps to one capability slot (STAGE_SLOTS in
 * lib/config/model-slots.ts); the base entries also mirror a `callLLM` source
 * label.
 *
 * `scene-content:<type>` are finer-grained composite keys: when a scene-content
 * request carries an `outline.type`, it resolves through that type's slot. Only the four
 * core scene types are routable; interactive widget sub-types are not split.
 *
 * `pbl-v2-runtime:<route>` keys follow the same composite fallback pattern:
 * a specific runtime endpoint can be routed independently, or inherit the base
 * `pbl-v2-runtime` model when no endpoint-specific route is configured.
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
  'pbl-v2-runtime',
  'pbl-v2-runtime:instructor',
  'pbl-v2-runtime:open-task',
  'pbl-v2-runtime:evaluate',
  'pbl-v2-runtime:simulator',
  'chat-adapter',
  'generate-classroom',
  'web-search-query-rewrite',
  'maic-agent-driver',
  'conversation-title',
] as const;

export type LlmStage = (typeof LLM_STAGES)[number];

/** Parse one route value (string model, or {model, thinking}) into a StageRoute. */
function parseRouteValue(key: string, value: unknown): StageRoute | undefined {
  if (typeof value === 'string') {
    return value.trim() ? { model: value.trim() } : undefined;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const model = typeof obj.model === 'string' ? obj.model.trim() : '';
    if (!model) {
      log.warn(`Route for stage "${key}" has no model string in x-model-routes; ignored.`);
      return undefined;
    }
    const route: StageRoute = { model };
    const api = typeof obj.api === 'string' ? obj.api.trim() : '';
    const dialect = typeof obj.dialect === 'string' ? obj.dialect.trim() : '';
    if (api || dialect) route.api = api || dialect;
    if (obj.api !== undefined && !api) {
      log.warn(
        dialect
          ? `Invalid api for stage "${key}" in x-model-routes; using dialect "${dialect}" instead.`
          : `Invalid api for stage "${key}" in x-model-routes; ignored.`,
      );
    }
    if (obj.dialect !== undefined && !dialect) {
      log.warn(
        api
          ? `Invalid dialect for stage "${key}" in x-model-routes; using api "${api}" instead.`
          : `Invalid dialect for stage "${key}" in x-model-routes; ignored.`,
      );
    }
    if (api && dialect && api !== dialect) {
      log.warn(`Both api and dialect are set for stage "${key}"; api wins.`);
    }
    if (obj.thinking !== undefined) {
      const thinking = parseThinking(key, obj.thinking);
      if (thinking) route.thinking = thinking;
    }
    if (obj.fallback !== undefined) {
      const fallback = typeof obj.fallback === 'string' ? obj.fallback.trim() : '';
      if (fallback) {
        route.fallback = fallback;
      } else {
        log.warn(`Invalid fallback for stage "${key}" in x-model-routes; ignored.`);
      }
    }
    if (obj.contextWindow !== undefined) {
      const contextWindow = obj.contextWindow;
      if (
        typeof contextWindow === 'number' &&
        Number.isFinite(contextWindow) &&
        Math.floor(contextWindow) >= 1
      ) {
        route.contextWindow = Math.floor(contextWindow);
      } else {
        log.warn(`Invalid contextWindow for stage "${key}" in x-model-routes; ignored.`);
      }
    }
    return route;
  }
  log.warn(`Invalid route value for stage "${key}" in x-model-routes ignored.`);
  return undefined;
}

/**
 * A user-level route entry (the `x-model-routes` header): a stage route plus
 * the client's own connection params for the routed provider. Server-managed providers ignore the client credentials
 * (resolveApiKey/resolveBaseUrl stay authoritative).
 */
export interface UserStageRoute extends StageRoute {
  apiKey?: string;
  baseUrl?: string;
  providerType?: string;
}

const MAX_USER_ROUTES_HEADER_BYTES = 16 * 1024;

/**
 * Parse the user-level `x-model-routes` header: a JSON object of
 * stage → `"provider:model"` or `{model, apiKey?, baseUrl?, providerType?}`.
 * Only known stages are kept; malformed entries are dropped with a warning.
 * Consulted only for a slot the configuration leaves unassigned, before the
 * client x-model (see resolveRequestedModel).
 */
export function parseUserStageRoutes(
  raw: string | null | undefined,
): Record<string, UserStageRoute> {
  const routes: Record<string, UserStageRoute> = {};
  if (!raw || typeof raw !== 'string') return routes;
  if (raw.length > MAX_USER_ROUTES_HEADER_BYTES) {
    log.warn(`x-model-routes header exceeds ${MAX_USER_ROUTES_HEADER_BYTES} bytes; ignored.`);
    return routes;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.warn('x-model-routes must be a JSON object of stage -> model; ignoring.');
      return routes;
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(LLM_STAGES as readonly string[]).includes(key)) {
        log.warn(`Unknown stage "${key}" in x-model-routes ignored.`);
        continue;
      }
      const route = parseRouteValue(key, value);
      if (!route) continue;
      const userRoute: UserStageRoute = { ...route };
      // The fallback model is the configuration's (the slot's fallback, see
      // lib/server/llm-fallback.ts); never accept it from the client header.
      delete userRoute.fallback;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if (typeof obj.apiKey === 'string' && obj.apiKey) userRoute.apiKey = obj.apiKey;
        if (typeof obj.baseUrl === 'string' && obj.baseUrl) userRoute.baseUrl = obj.baseUrl;
        if (typeof obj.providerType === 'string' && obj.providerType)
          userRoute.providerType = obj.providerType;
      }
      routes[key] = userRoute;
    }
  } catch (err) {
    log.warn('Invalid x-model-routes JSON; ignoring.', err);
  }
  return routes;
}

/**
 * Resolve a user route for a stage, most specific key first
 * (scene-content:quiz → scene-content).
 */
export function getUserStageRoute(
  userRoutes: Record<string, UserStageRoute>,
  stage?: string,
): UserStageRoute | undefined {
  if (!stage) return undefined;
  let key: string | undefined = stage;
  while (key) {
    const route = userRoutes[key];
    if (route) return route;
    const lastColon = key.lastIndexOf(':');
    key = lastColon > 0 ? key.slice(0, lastColon) : undefined;
  }
  return undefined;
}
