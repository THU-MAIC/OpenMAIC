import { createLogger } from '@/lib/logger';

const log = createLogger('FetchRetry');

/**
 * Fetch wrapper that retries on transient network failures.
 *
 * Safari throws "Load failed" and Chrome "Failed to fetch" when a connection
 * drops — common during long generation flows on mobile when the screen dims
 * or Safari throttles background tabs. Retrying once or twice usually succeeds.
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (init?.signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return await fetch(input, init);
    } catch (err) {
      lastError = err;
      // Don't retry user-initiated aborts
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (attempt < maxRetries) {
        const delay = 1000 * (attempt + 1); // 1s, 2s
        log.warn(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}
