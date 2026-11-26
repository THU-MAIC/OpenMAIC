import { apiSuccess } from '@/lib/server/api-response';
import { getRenderServiceCapability } from '@/lib/server/render-service';
import { isRenderDurableQueueEnabled } from '@/lib/server/render-queue/config';

export const dynamic = 'force-dynamic';

/**
 * Report whether one-click MP4 export is available. "Available" means the
 * service is configured, healthy, and explicitly supports owner-bound jobs.
 * A configured-but-absent or older service reports disabled, so the menu shows
 * only "Download ZIP" instead of advertising an MP4 export that would fail.
 * Never leaks the service URL to the client.
 */
export async function GET() {
  const { enabled, accepting } = await getRenderServiceCapability();
  // With the durable queue, a job waits in PostgreSQL while the render service
  // is busy, so room is the queue's, not the service's.
  if (enabled && isRenderDurableQueueEnabled()) {
    const { queuedRenderAccepting } = await import('@/lib/server/render-queue/routes');
    return apiSuccess({ enabled: true, accepting: await queuedRenderAccepting() });
  }
  return apiSuccess({ enabled, ...(accepting !== undefined ? { accepting } : {}) });
}
