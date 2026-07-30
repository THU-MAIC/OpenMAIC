/**
 * `fetch()` hardened for weak 3G/4G links: each attempt is time-bounded and
 * network errors / timeouts are retried with exponential backoff. Built on the
 * shared {@link retryWithBackoff}.
 *
 * Deliberately does NOT inspect HTTP status — the resolved Response is returned
 * as-is, so callers keep checking `res.ok`, and non-idempotent requests stay
 * safe (only network-level failures and timeouts retry, never a 5xx body that
 * may have had a side effect). The caller's own AbortSignal cancels immediately
 * and is never retried.
 *
 * Unit-tested in `tests/utils/resilient-fetch.test.ts`.
 */

import { retryWithBackoff } from './concurrency';

export interface ResilientFetchOptions extends RequestInit {
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Backoff base in ms (default 600). */
  baseDelayMs?: number;
}

export async function resilientFetch(
  input: RequestInfo | URL,
  options: ResilientFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    retries = 2,
    baseDelayMs = 600,
    signal: callerSignal,
    ...init
  } = options;
  // RequestInit.signal is AbortSignal | null | undefined; normalise null away.
  const signal = callerSignal ?? undefined;

  return retryWithBackoff(
    async () => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
      return await fetch(input, { ...init, signal: composed });
    },
    {
      retries,
      baseDelayMs,
      signal,
      // Retry network errors and per-attempt timeouts, but never once the
      // caller has cancelled (their abort should surface immediately).
      shouldRetry: () => !signal?.aborted,
    },
  );
}
