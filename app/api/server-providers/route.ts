import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getParallelSceneConcurrency,
} from '@/lib/server/provider-config';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';
import { readCodexProviderStatus } from '@/lib/server/codex/account';

const log = createLogger('ServerProviders');

export async function GET() {
  try {
    const providers = getServerProviders();
    try {
      const codex = await readCodexProviderStatus();
      if (codex.account?.type === 'chatgpt' && codex.models.length > 0) {
        providers.codex = {
          models: codex.models.map((model) => model.id),
        };
      }
    } catch (error) {
      // An optional local transport must not hide otherwise healthy providers.
      log.warn('Codex provider status is unavailable:', error);
    }

    return apiSuccess({
      providers,
      tts: getServerTTSProviders(),
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: getServerImageProviders(),
      video: getServerVideoProviders(),
      webSearch: getServerWebSearchProviders(),
      generation: {
        parallelSceneConcurrency: getParallelSceneConcurrency(),
      },
    });
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}
