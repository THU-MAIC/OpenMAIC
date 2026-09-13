/**
 * Media Proxy API
 *
 * Server-side proxy for fetching remote media URLs (images/videos).
 * Required because browser fetch() to remote CDN URLs fails with CORS errors.
 * The media orchestrator uses this to download generated media as blobs
 * for IndexedDB persistence.
 *
 * POST /api/proxy-media
 * Body: { url: string }
 * Response: Binary blob with appropriate Content-Type
 */

import { NextRequest, NextResponse } from 'next/server';
import type { Dispatcher } from 'undici';
import { findUnsafeNetworkTargetError, validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { createValidatedDispatcher } from '@/lib/server/pinned-dispatcher';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('ProxyMedia');

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  let url: string | undefined;
  let dispatcher: Dispatcher | undefined;
  try {
    ({ url } = await request.json());

    if (!url || typeof url !== 'string') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing or invalid url');
    }

    // Initial SSRF validation
    const ssrfError = await validateUrlForSSRF(url);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    // Pin every connection to the exact address set the connect-time lookup
    // approved, closing the window where the HTTP client resolves the hostname
    // again and could reach an internal address after the guard saw a public one.
    dispatcher = createValidatedDispatcher();

    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let response: Response;
    // Node's global fetch is undici and accepts a `dispatcher`, which the DOM
    // RequestInit type does not model.
    const hopInit: RequestInit & { dispatcher: Dispatcher } = {
      redirect: 'manual',
      dispatcher,
    };
    for (let hop = 0; ; hop++) {
      response = await fetch(currentUrl, hopInit);
      if (response.status < 300 || response.status >= 400) break; // not a redirect
      const location = response.headers.get('location');
      if (!location)
        return apiError('UPSTREAM_ERROR', 502, 'Redirect response without Location header');
      if (hop >= MAX_REDIRECTS) return apiError('TOO_MANY_REDIRECTS', 502, 'Too many redirects');
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).href; // resolve relative redirects
      } catch {
        return apiError('INVALID_URL', 502, 'Invalid redirect Location');
      }
      // Re-validate each redirect hop to prevent redirect-to-internal SSRF (#398)
      const hopError = await validateUrlForSSRF(nextUrl);
      if (hopError) return apiError('INVALID_URL', 403, hopError);
      currentUrl = nextUrl;
    }

    if (!response!.ok) {
      // Forward client (4xx) errors as-is so the caller treats them as permanent
      // (no retry); collapse upstream server (5xx) errors to 502.
      const status = response!.status >= 400 && response!.status < 500 ? response!.status : 502;
      return apiError('UPSTREAM_ERROR', status, `Upstream returned ${response!.status}`);
    }

    const MAX_PROXY_BYTES = 25 * 1024 * 1024; // 25 MiB
    const contentLength = Number(response!.headers.get('content-length') ?? '');
    if (Number.isFinite(contentLength) && contentLength > MAX_PROXY_BYTES) {
      return apiError('UPSTREAM_ERROR', 502, `Upstream asset too large (${contentLength} bytes)`);
    }
    const blob = await response!.blob();
    if (blob.size > MAX_PROXY_BYTES) {
      return apiError('UPSTREAM_ERROR', 502, `Upstream asset too large (${blob.size} bytes)`);
    }
    const contentType = response!.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(blob, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(blob.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    // A connect-time refusal from the pinned dispatcher is the same SSRF policy
    // the URL-layer guard enforces, so report it as an invalid URL (403), not
    // as an internal error (undici wraps the lookup error as `fetch failed`).
    const blocked = findUnsafeNetworkTargetError(error);
    if (blocked) {
      return apiError('INVALID_URL', 403, blocked.message);
    }
    log.error(`Proxy media failed [url="${url?.substring(0, 100) ?? 'unknown'}"]:`, error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  } finally {
    // The response blob (if any) is already fully in memory here, so tear the
    // pool down immediately instead of draining it. `close()` waits for
    // in-flight requests, and the response body is intentionally left unread on
    // the 30x, non-2xx, oversize and connect-refusal paths, so awaiting it would
    // hang the handler until the upstream ends a body nobody reads.
    void dispatcher?.destroy().catch(() => undefined);
  }
}
