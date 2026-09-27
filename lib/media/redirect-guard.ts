/**
 * Redirect handling for the media provider adapters.
 *
 * These requests carry the provider credential and go to a base URL that comes
 * from provider settings, which a caller can supply. Following a redirect would
 * replay that credential at a host the caller chose, and would let a host that
 * answers once reach addresses the SSRF guard already refused. So every adapter
 * call that talks to a provider endpoint passes `redirect: 'manual'` and treats
 * any 3xx as an error — the same rule the connectivity probes apply in
 * `probe-auth.ts`, extended to the generation and poll calls those probes left
 * following redirects.
 *
 * `fetch` with `redirect: 'manual'` returns the 3xx response itself rather than
 * an opaque one, so the status is readable here.
 */
export function assertNotRedirected(response: Response, providerName: string): void {
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`${providerName}: Redirects are not allowed (HTTP ${response.status})`);
  }
}
