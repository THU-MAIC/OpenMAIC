import { type NextRequest } from 'next/server';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { proxyFetch } from '@/lib/server/proxy-fetch';
import { resolveRenderServiceUrl } from '@/lib/server/render-service';
import { createLogger } from '@/lib/logger';

const log = createLogger('ExportVideo Job API');

export const dynamic = 'force-dynamic';

/** Relay a render job's status. Polled by the client while a render runs. */
export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const resolved = resolveRenderServiceUrl();
  if ('error' in resolved) {
    return apiError('PROVIDER_DISABLED', 501, 'Render service is not configured');
  }

  try {
    const upstream = await proxyFetch(`${resolved.url}/render/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    if (!upstream.ok) {
      const status = upstream.status === 404 ? 404 : 502;
      return apiError('UPSTREAM_ERROR', status, 'Render job lookup failed');
    }
    return apiSuccess({ ...data, pollIntervalMs: 3000 });
  } catch (error) {
    log.error(`Failed to poll render job ${jobId}:`, error);
    return apiError('UPSTREAM_ERROR', 502, 'Failed to reach render service');
  }
}

/** Cancel a queued/running render job. */
export async function DELETE(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const resolved = resolveRenderServiceUrl();
  if ('error' in resolved) {
    return apiError('PROVIDER_DISABLED', 501, 'Render service is not configured');
  }

  try {
    const upstream = await proxyFetch(`${resolved.url}/render/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok && upstream.status !== 404) {
      return apiError('UPSTREAM_ERROR', 502, 'Failed to cancel render job');
    }
    return apiSuccess({ cancelled: true });
  } catch (error) {
    log.error(`Failed to cancel render job ${jobId}:`, error);
    return apiError('UPSTREAM_ERROR', 502, 'Failed to reach render service');
  }
}
