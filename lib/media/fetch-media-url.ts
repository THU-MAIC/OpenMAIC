/**
 * Fetch a media URL through the same-origin media proxy when it is remote.
 * A plain browser fetch is CORS-blocked for cross-origin media exactly where
 * a media element would still play, and the proxy carries the SSRF guard and
 * its response limit. Same-origin absolute URLs go direct: the proxy's SSRF
 * guard rejects loopback and private-network targets unless the deployment
 * opts in, and a self-hosted deployment's own media routes are exactly that.
 * Local schemes (data:, relative) go direct. Always bounded; the caller maps
 * the response.
 */
export function fetchMediaUrl(url: string, timeoutMs: number): Promise<Response> {
  const init = { signal: AbortSignal.timeout(timeoutMs) };
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const sameOrigin =
      typeof location !== 'undefined' && new URL(url, location.href).origin === location.origin;
    if (sameOrigin) return fetch(url, init);
    return fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      ...init,
    });
  }
  return fetch(url, init);
}
