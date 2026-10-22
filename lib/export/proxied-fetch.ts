/**
 * A fetch implementation that routes asset requests through the same-origin
 * /api/proxy-media endpoint. Callers that also handle browser-owned URLs can opt
 * into cross-origin-only mode so local, blob, and data URLs stay direct, and can
 * try a CORS-enabled CDN directly before falling back to the bounded proxy. The
 * proxy validates the URL server-side (SSRF guard) and returns the bytes.
 *
 * Hosted interactive-scene libraries are always fetched directly: they are
 * static files served with CORS, and on a localhost or private-address
 * deployment the proxy's SSRF guard would reject them.
 */
import { interactiveAssetBaseUrl } from '@openmaic/generation/browser';
import { fetchProxiedMediaUrl } from '@/lib/media/proxy-media-cache';

function isInteractiveAsset(url: URL, pageHref: string | undefined): boolean {
  try {
    const base = new URL(interactiveAssetBaseUrl().replace(/\/?$/, '/'), pageHref);
    return url.origin === base.origin && url.pathname.startsWith(base.pathname);
  } catch {
    return false;
  }
}

export function createProxiedFetch(
  options: { crossOriginOnly?: boolean; directFirst?: boolean } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pageHref = typeof location !== 'undefined' ? location.href : undefined;
    let shouldProxy = false;
    try {
      const resolved = pageHref ? new URL(url, pageHref) : new URL(url);
      if (isInteractiveAsset(resolved, pageHref)) return fetch(input, init);
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
