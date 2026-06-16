/**
 * Per-stage LLM model routing (issue #745).
 *
 * Optional, config-only overrides that map a generation *stage* to a specific
 * model string. Consulted during model resolution and falling back to today's
 * behavior (`DEFAULT_MODEL`) when unset — zero behavior change unless opted in.
 *
 * Surface: a single JSON env var `MODEL_ROUTES`. Model strings use the canonical
 * `provider:model` format (see parseModelString), e.g.
 *
 *   DEFAULT_MODEL=openai:gpt-5.4-mini
 *   MODEL_ROUTES='{"scene-content":"openai:gpt-5.4","pbl-chat":"anthropic:claude-sonnet-4"}'
 *
 * Only the *routable* stages below are valid keys — each is backed by a real
 * `resolveModel` call site. Downstream sub-calls (e.g. `pbl-generate`,
 * `chat-adapter-stream`) inherit their parent stage's resolved model.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('model-routes');

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
] as const;

export type LlmStage = (typeof LLM_STAGES)[number];

/** Parsed once per process (env is read at startup; tests reset via vi.resetModules). */
let _routes: Record<string, string> | null = null;

function loadRoutes(): Record<string, string> {
  if (_routes) return _routes;

  const routes: Record<string, string> = {};
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
          if (typeof value === 'string' && value.trim()) {
            routes[key] = value.trim();
          } else {
            log.warn(`Non-string model for stage "${key}" in MODEL_ROUTES ignored.`);
          }
        }
      } else {
        log.error('MODEL_ROUTES must be a JSON object of stage -> model string; ignoring.');
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
export function getStageModel(stage?: string): string | undefined {
  if (!stage) return undefined;
  const routes = loadRoutes();
  let key: string | undefined = stage;
  while (key) {
    const model = routes[key];
    if (model) return model;
    const lastColon = key.lastIndexOf(':');
    key = lastColon > 0 ? key.slice(0, lastColon) : undefined;
  }
  return undefined;
}
