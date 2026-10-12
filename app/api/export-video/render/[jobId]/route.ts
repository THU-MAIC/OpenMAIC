import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import {
  isRenderOwnerBoundResponse,
  renderServiceOwnerHeaders,
  resolveRenderServiceUrl,
  withRenderOwnerResponseHeaders,
} from '@/lib/server/render-service';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideo Job API');

export const dynamic = 'force-dynamic';

/** Relay a render job's status. Polled by the client while a render runs. */
export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const answer = (response: Response) =>
      withRenderOwnerResponseHeaders(response, responseHeaders);
    const { jobId } = await context.params;
    const resolved = resolveRenderServiceUrl();
    if ('error' in resolved) {
      return answer(apiError('PROVIDER_DISABLED', 501, 'Render service is not configured'));
    }

    try {
      const upstream = await proxyFetch(
        `${resolved.url}/owner-bound/render/${encodeURIComponent(jobId)}`,
        {
          method: 'GET',
          headers: renderServiceOwnerHeaders(ownerId),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!isRenderOwnerBoundResponse(upstream)) {
        return answer(
          apiError('UPSTREAM_ERROR', 502, 'Render service must be upgraded before reading jobs'),
        );
      }
      const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
      if (!upstream.ok) {
        const status = upstream.status === 404 ? 404 : 502;
        return answer(apiError('UPSTREAM_ERROR', status, 'Render job lookup failed'));
      }
      return answer(apiSuccess({ ...data, pollIntervalMs: 3000 }));
    } catch (error) {
      log.error(`Failed to poll render job ${jobId}:`, error);
      return answer(apiError('UPSTREAM_ERROR', 502, 'Failed to reach render service'));
    }
  });
}

/** Cancel a queued/running render job. */
export async function DELETE(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const answer = (response: Response) =>
      withRenderOwnerResponseHeaders(response, responseHeaders);
    const { jobId } = await context.params;
    const resolved = resolveRenderServiceUrl();
    if ('error' in resolved) {
      return answer(apiError('PROVIDER_DISABLED', 501, 'Render service is not configured'));
    }

    try {
      const upstream = await proxyFetch(
        `${resolved.url}/owner-bound/render/${encodeURIComponent(jobId)}`,
        {
          method: 'DELETE',
          headers: renderServiceOwnerHeaders(ownerId),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!isRenderOwnerBoundResponse(upstream)) {
        return answer(
          apiError('UPSTREAM_ERROR', 502, 'Render service must be upgraded before cancelling jobs'),
        );
      }
      if (upstream.status === 404) {
        return answer(apiError('UPSTREAM_ERROR', 404, 'Render job lookup failed'));
      }
      if (!upstream.ok) {
        return answer(apiError('UPSTREAM_ERROR', 502, 'Failed to cancel render job'));
      }
      return answer(apiSuccess({ cancelled: true }));
    } catch (error) {
      log.error(`Failed to cancel render job ${jobId}:`, error);
      return answer(apiError('UPSTREAM_ERROR', 502, 'Failed to reach render service'));
    }
  });
}
