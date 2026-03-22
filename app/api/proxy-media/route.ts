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
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { apiError } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('ProxyMedia');

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== 'string') {
      return apiError('MISSING_REQUIRED_FIELD', 400, 'Missing or invalid url');
    }

    // Block local/private network URLs to prevent SSRF
    const ssrfError = validateUrlForSSRF(url);
    if (ssrfError) {
      return apiError('INVALID_URL', 403, ssrfError);
    }

    // Follow redirects manually with SSRF validation on each hop
    let currentUrl = url;
    const MAX_REDIRECTS = 5;
    let response: Response | undefined;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      response = await fetch(currentUrl, { redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return apiError('REDIRECT_NOT_ALLOWED', 403, 'Redirect without Location header');
        }
        // Resolve relative redirects
        const redirectUrl = new URL(location, currentUrl).toString();
        const redirectSsrfError = validateUrlForSSRF(redirectUrl);
        if (redirectSsrfError) {
          return apiError('INVALID_URL', 403, `Redirect target blocked: ${redirectSsrfError}`);
        }
        currentUrl = redirectUrl;
        continue;
      }
      break;
    }
    if (!response || (response.status >= 300 && response.status < 400)) {
      return apiError('REDIRECT_NOT_ALLOWED', 403, 'Too many redirects');
    }
    if (!response.ok) {
      return apiError('UPSTREAM_ERROR', 502, `Upstream returned ${response.status}`);
    }

    const blob = await response.blob();
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(blob, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(blob.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    log.error('Proxy media error:', error);
    return apiError('INTERNAL_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
