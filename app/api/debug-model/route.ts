import { apiSuccess, apiError } from '@/lib/server/api-response';
import { resolveModel } from '@/lib/server/resolve-model';

export async function GET() {
  try {
    const { modelString, providerId, apiKey } = await resolveModel({});
    return apiSuccess({
      modelString,
      providerId,
      hasApiKey: !!apiKey,
      rawEnvDefaultModel: process.env.DEFAULT_MODEL || '(not set)',
    });
  } catch (error) {
    return apiError('RESOLVE_ERROR', 500, error instanceof Error ? error.message : String(error));
  }
}
