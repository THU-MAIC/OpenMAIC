import { NextResponse, type NextRequest } from 'next/server';
import { apiError } from '@/lib/server/api-response';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import {
  isRenderOwnerBoundResponse,
  renderServiceOwnerHeaders,
  resolveRenderServiceUrl,
  withRenderOwnerResponseHeaders,
} from '@/lib/server/render-service';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideo Download API');

export const dynamic = 'force-dynamic';

/**
 * Stream the rendered MP4 back to the browser.
 *
 * Uses `redirect: 'manual'` so that if the render service's artifact store
 * returns a `302` (a presigned object-storage URL, in a demo-scale deployment)
 * we pass that redirect straight through and the browser downloads directly
 * from storage — bypassing this proxy. The OSS default (local-disk artifacts)
 * streams the bytes through here.
 */
export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const answer = (response: Response) =>
      withRenderOwnerResponseHeaders(response, responseHeaders);
    const { jobId } = await context.params;
    const resolved = resolveRenderServiceUrl();
    if ('error' in resolved) {
      return answer(apiError('PROVIDER_DISABLED', 501, 'Render service is not configured'));
    }

    // Bound only the time to obtain the response headers — NOT the body stream.
    // A total-duration timeout would truncate a large MP4 over a slow connection,
    // so we abort just the initial fetch and clear the timer once headers arrive.
    const controller = new AbortController();
    const headerTimeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const upstream = await proxyFetch(
        `${resolved.url}/owner-bound/render/${encodeURIComponent(jobId)}/download`,
        {
          method: 'GET',
          redirect: 'manual',
          headers: renderServiceOwnerHeaders(ownerId),
          signal: controller.signal,
        },
      );
      clearTimeout(headerTimeout);
      if (!isRenderOwnerBoundResponse(upstream)) {
        return answer(
          apiError(
            'UPSTREAM_ERROR',
            502,
            'Render service must be upgraded before downloading jobs',
          ),
        );
      }

      // Presigned-URL artifact store: hand the redirect to the browser.
      if (upstream.status === 302 || upstream.status === 301) {
        const location = upstream.headers.get('location');
        if (location) return answer(NextResponse.redirect(location, 302));
      }

      if (!upstream.ok || !upstream.body) {
        const status = upstream.status === 404 || upstream.status === 409 ? upstream.status : 502;
        return answer(apiError('UPSTREAM_ERROR', status, 'Render output not available'));
      }

      const contentLength = upstream.headers.get('content-length');
      return answer(
        new NextResponse(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'video/mp4',
            ...(contentLength ? { 'Content-Length': contentLength } : {}),
            'Content-Disposition': `attachment; filename="${jobId}.mp4"`,
            'Cache-Control': 'private, no-store',
          },
        }),
      );
    } catch (error) {
      clearTimeout(headerTimeout);
      log.error(`Failed to download render output ${jobId}:`, error);
      return answer(apiError('UPSTREAM_ERROR', 502, 'Failed to reach render service'));
    }
  });
}
