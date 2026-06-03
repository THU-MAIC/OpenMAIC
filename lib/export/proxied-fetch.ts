/**
 * A fetch implementation that routes asset requests through the same-origin
 * /api/proxy-media endpoint, bypassing cross-origin CORS restrictions that block
 * direct browser fetches to CDNs like cdn.tailwindcss.com or CORS-locked image hosts.
 * The proxy validates the URL server-side (SSRF guard) and returns the bytes.
 */
export function createProxiedFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    return fetch('/api/proxy-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
  }) as unknown as typeof fetch;
}
