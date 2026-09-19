import { fetchProxiedMediaUrl } from './proxy-media-cache';

async function waitForRenderedMedia(url: string, maxWaitMs: number): Promise<void> {
  if (typeof document === 'undefined' || typeof location === 'undefined') return;
  const target = new URL(url, location.href).href;
  const element = [
    ...document.querySelectorAll<HTMLImageElement | HTMLMediaElement>(
      'img[src],video[src],audio[src]',
    ),
  ].find((candidate) => {
    const source = candidate.currentSrc || candidate.getAttribute('src');
    return source ? new URL(source, location.href).href === target : false;
  });
  if (!element) return;
  if (element.tagName === 'IMG' && (element as HTMLImageElement).complete) return;
  if (element.tagName !== 'IMG' && (element as HTMLMediaElement).readyState >= 2) return;

  await new Promise<void>((resolve) => {
    const events = element.tagName === 'IMG' ? ['load', 'error'] : ['loadeddata', 'error'];
    const finish = () => {
      window.clearTimeout(timer);
      for (const event of events) element.removeEventListener(event, finish);
      resolve();
    };
    const timer = window.setTimeout(finish, maxWaitMs);
    for (const event of events) element.addEventListener(event, finish, { once: true });
  });
}

/**
 * Fetch a media URL through the same-origin media proxy when it is remote.
 * A plain browser fetch is CORS-blocked for cross-origin media exactly where
 * a media element would still play, and the proxy carries the SSRF guard and
 * its response limit. Same-origin absolute URLs go direct: the proxy's SSRF
 * guard rejects loopback and private-network targets unless the deployment
 * opts in, and a self-hosted deployment's own media routes are exactly that.
 * Local schemes (data:, relative) go direct. Always bounded; the caller maps
 * the response.
 *
 * Cross-origin requests route through the shared proxy-media negative cache:
 * a 4xx verdict for a URL is remembered for the session and later calls
 * short-circuit without a network request, so callers that re-probe the same
 * URL on every load/play tick (legacy asset conversion, exports) cannot spam
 * the proxy with a URL the upstream has permanently refused.
 */
export function fetchMediaUrl(
  url: string,
  timeoutMs: number,
  options: { cache?: RequestCache; waitForRenderedMedia?: boolean } = {},
): Promise<Response> {
  const init = { signal: AbortSignal.timeout(timeoutMs) };
  const directInit: RequestInit = { ...init, ...(options.cache ? { cache: options.cache } : {}) };
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const sameOrigin =
      typeof location !== 'undefined' && new URL(url, location.href).origin === location.origin;
    if (sameOrigin) {
      return (
        options.waitForRenderedMedia ? waitForRenderedMedia(url, 2_000) : Promise.resolve()
      ).then(() => fetch(url, directInit));
    }
    return fetchProxiedMediaUrl(url, init);
  }
  return (options.waitForRenderedMedia ? waitForRenderedMedia(url, 2_000) : Promise.resolve()).then(
    () => fetch(url, directInit),
  );
}
