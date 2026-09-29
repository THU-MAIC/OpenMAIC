import { apiSuccess } from '@/lib/server/api-response';
import { resolveServerGenerationCapabilities } from '@/lib/server/generation-capabilities';

const version = process.env.npm_package_version || '0.1.0';

export async function GET() {
  return apiSuccess({
    status: 'ok',
    version,
    accessCodeConfigured: Boolean(process.env.ACCESS_CODE),
    capabilities: await resolveServerGenerationCapabilities(),
  });
}
