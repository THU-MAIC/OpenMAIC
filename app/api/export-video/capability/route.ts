import { apiSuccess } from '@/lib/server/api-response';
import { getRenderServiceCapability } from '@/lib/server/render-service';

export const dynamic = 'force-dynamic';

/**
 * Report whether one-click MP4 export is available. "Available" means the
 * service is configured, healthy, and explicitly supports owner-bound jobs.
 * A configured-but-absent or older service reports disabled, so the menu shows
 * only "Download ZIP" instead of advertising an MP4 export that would fail.
 * Never leaks the service URL to the client.
 */
export async function GET() {
  const capability = await getRenderServiceCapability();
  return apiSuccess({ ...capability });
}
