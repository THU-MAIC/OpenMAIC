/**
 * A fetch implementation that routes asset requests through the same-origin
 * /api/proxy-media endpoint. Callers that also handle browser-owned URLs can opt
 * into cross-origin-only mode so local, blob, and data URLs stay direct, and can
 * try a CORS-enabled CDN directly before falling back to the bounded proxy. The
 * proxy validates the URL server-side (SSRF guard) and returns the bytes.
 */
import { fetchProxiedMediaUrl } from '@/lib/media/proxy-media-cache';

export function createProxiedFetch(
  options: { crossOriginOnly?: boolean; directFirst?: boolean } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pageHref = typeof location !== 'undefined' ? location.href : undefined;
    let shouldProxy = false;
    try {
      const resolved = pageHref ? new URL(url, pageHref) : new URL(url);
      shouldProxy =
        (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
        (!pageHref || resolved.origin !== new URL(pageHref).origin);
    } catch {
      // Relative and browser-owned URLs are fetched directly.
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (options.crossOriginOnly && !shouldProxy) return fetch(input, init);
    if (options.directFirst) {
      try {
        return await fetch(input, init);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    return fetchProxiedMediaUrl(url, { signal });
  }) as unknown as typeof fetch;
}
