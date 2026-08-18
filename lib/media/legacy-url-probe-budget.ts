/**
 * Shared wall-clock budget for best-effort reads of legacy media URLs.
 *
 * Every legacy URL path uses this instead of independently applying a
 * per-request timeout. The caller asks for a timeout immediately before
 * starting a fetch: once the shared deadline passes, no more requests start;
 * otherwise the request is capped by whichever is smaller, its normal timeout
 * or the time remaining in this pass.
 */
export const LEGACY_URL_PROBE_BUDGET_MS = 60_000;
export const LEGACY_URL_PROBE_TIMEOUT_MS = 15_000;

export interface LegacyUrlProbeBudget {
  /** Milliseconds remaining before the shared deadline; never negative. */
  remainingMs(): number;
  /**
   * Reserve the timeout for one fetch started now, or return `null` when the
   * shared deadline has already expired.
   */
  nextTimeoutMs(): number | null;
}

export function createLegacyUrlProbeBudget(
  budgetMs = LEGACY_URL_PROBE_BUDGET_MS,
  perProbeTimeoutMs = LEGACY_URL_PROBE_TIMEOUT_MS,
  now: () => number = Date.now,
): LegacyUrlProbeBudget {
  const deadline = now() + budgetMs;

  const remainingMs = (): number => Math.max(0, deadline - now());

  return {
    remainingMs,
    nextTimeoutMs(): number | null {
      const remaining = remainingMs();
      return remaining > 0 ? Math.min(perProbeTimeoutMs, remaining) : null;
    },
  };
}
