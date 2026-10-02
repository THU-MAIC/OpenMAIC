/**
 * Whether `error` is the refusal a `redirect: 'error'` fetch raises for a 3xx.
 * Undici reports it as `TypeError: fetch failed` with an
 * `Error('unexpected redirect')` somewhere in the `cause` chain.
 *
 * Kept free of imports so browser-bundled modules (the media adapters) can
 * share it with the server transport.
 */
export function isRejectedRedirectError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string' && /unexpected redirect/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
