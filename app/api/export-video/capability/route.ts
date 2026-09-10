import { apiSuccess } from '@/lib/server/api-response';
import { checkRenderServiceHealth } from '@/lib/server/render-service';

export const dynamic = 'force-dynamic';

/**
 * Report whether one-click MP4 export is available. "Available" means the
 * service is configured AND its `/health` responds — so a configured-but-absent
 * service (e.g. RENDER_SERVICE_URL set but the container not started) reports
 * disabled and the menu shows only "Download ZIP" rather than advertising an
 * MP4 export that would then fail. Never leaks the service URL to the client.
 *
 * `accepting` additionally forwards the service's queue-cap admission signal
 * (#1348) so the dialog can pre-empt a render the queue would reject (#1350).
 * It is advisory and never gates the capability itself: a busy queue still
 * leaves MP4 export advertised, and the service's 429 stays authoritative.
 */
export async function GET() {
  const { enabled, accepting } = await checkRenderServiceHealth();
  return apiSuccess({ enabled, accepting });
}
