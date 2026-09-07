/**
 * Move a call to the next model when the current one is out of quota.
 *
 * A free-tier key meters each model separately and per day, so the model a
 * stage is routed to is the first to run dry while its siblings still have
 * headroom. The retry that already exists in `callLLM` and in the outlines
 * route does not help: it re-sends to the *same* exhausted model and burns its
 * attempts on an error that cannot clear within the call. That is what a
 * generation failure looks like in the log — three attempts, three 429s, then
 * "LLM returned empty response".
 *
 * This module supplies the missing piece: a chain of models to walk when, and
 * only when, the failure is a quota or rate-limit rejection. Any other error
 * (a bad prompt, a malformed schema, a network fault) still fails where it
 * happened, because retrying it elsewhere would only hide the real cause and
 * spend a second model's quota to do so.
 *
 * Configure with `MODEL_FALLBACKS`, either JSON or comma-separated:
 *
 *     MODEL_FALLBACKS='["google:gemini-3.6-flash","google:gemini-3.5-flash-lite"]'
 *     MODEL_FALLBACKS=google:gemini-3.6-flash,google:gemini-3.5-flash-lite
 *
 * Unset means the previous behaviour, unchanged: no failover.
 */

import { createLogger } from '@/lib/logger';
import { resolveModel } from '@/lib/server/resolve-model';
import type { LanguageModel } from 'ai';

const log = createLogger('ModelFallback');

/** Model strings to try, in order, after a quota rejection. */
export function getFallbackChain(): string[] {
  const raw = process.env.MODEL_FALLBACKS?.trim();
  if (!raw) return [];

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log.warn('MODEL_FALLBACKS must be a JSON array of model strings; ignored.');
        return [];
      }
      return parsed.filter((v): v is string => typeof v === 'string' && v.includes(':'));
    } catch {
      log.warn('MODEL_FALLBACKS is not valid JSON; ignored.');
      return [];
    }
  }

  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.includes(':'));
}

/**
 * Whether an error means "this model has no capacity for you right now".
 *
 * Covers the shapes the AI SDK produces: a bare `APICallError` with a status
 * code, and a `RetryError` that wraps the last one after its own backoff gave
 * up. Google reports daily free-tier exhaustion as 429 / RESOURCE_EXHAUSTED;
 * 503 is a transient server overload rather than a quota fact, but it is worth
 * moving on from too — the alternative is stalling on one busy model while
 * another is idle.
 */
export function isCapacityError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let node: unknown = error;

  for (let depth = 0; node && depth < 5; depth++) {
    if (seen.has(node)) break;
    seen.add(node);

    const e = node as { statusCode?: number; message?: string; lastError?: unknown; cause?: unknown };
    if (e.statusCode === 429 || e.statusCode === 503) return true;
    if (
      typeof e.message === 'string' &&
      /\b429\b|\b503\b|exceeded your current quota|RESOURCE_EXHAUSTED|rate.?limit|overloaded|high demand/i.test(
        e.message,
      )
    ) {
      return true;
    }

    node = e.lastError ?? e.cause;
  }

  return false;
}

/**
 * Call sources that must never fail over.
 *
 * Failover is right when the caller wants *an answer* and any capable model
 * will do. It is wrong when the caller wants to know something *about a
 * particular model* — `verify-model` sends a probe to the exact model a user
 * typed in and reports whether it works. Quietly answering from a different
 * model would make it report a dead or mis-keyed model as healthy, which is
 * worse than the failure it was asked to detect.
 */
const NO_FALLBACK_SOURCES = new Set(['verify-model']);

/** Whether a call made under this source label may switch models. */
export function isFallbackEligible(source: string): boolean {
  return !NO_FALLBACK_SOURCES.has(source);
}

export interface FallbackModel {
  model: LanguageModel;
  modelString: string;
}

/**
 * Build the next untried model in the chain, or `null` when the chain is spent.
 *
 * `tried` is mutated to record every candidate handed out, so a caller looping
 * over failures cannot be served the same model twice and cannot loop forever.
 * Pass the model that just failed in `tried` before the first call.
 */
export async function nextFallbackModel(tried: Set<string>): Promise<FallbackModel | null> {
  for (const candidate of getFallbackChain()) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      const resolved = await resolveModel({ modelString: candidate });
      return { model: resolved.model, modelString: candidate };
    } catch (err) {
      // A chain entry naming a provider with no key configured is a config
      // mistake, not a reason to abandon the remaining candidates.
      log.warn(`Fallback model "${candidate}" could not be resolved; skipping.`, err);
    }
  }
  return null;
}
