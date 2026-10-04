import { apiSuccess } from '@/lib/server/api-response';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';
import { getParallelSceneConcurrency } from '@/lib/server/provider-config';

const version = process.env.npm_package_version || '0.1.0';

export async function GET() {
  return apiSuccess({
    status: 'ok',
    version,
    accessCodeConfigured: Boolean(process.env.ACCESS_CODE),
    capabilities: await resolveServerGenerationCapabilities(),
    // How many scenes the browser may generate at once (PARALLEL_SCENE_CONCURRENCY).
    generation: { parallelSceneConcurrency: getParallelSceneConcurrency() },
  });
}
