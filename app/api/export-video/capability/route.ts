import { apiSuccess } from '@/lib/server/api-response';
import { checkRenderServiceHealth } from '@/lib/server/render-service';

export const dynamic = 'force-dynamic';

/**
 * Report whether one-click MP4 export is available. "Available" means the
 * service is configured AND its `/health` responds — so a configured-but-absent
 * service (e.g. RENDER_SERVICE_URL set but the container not started) reports
 * disabled and the menu shows only "Download ZIP" rather than advertising an
 * MP4 export that would then fail. Never leaks the service URL to the client.
 */
export async function GET() {
  const enabled = await checkRenderServiceHealth();
  return apiSuccess({ enabled });
}
