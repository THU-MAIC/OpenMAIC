import { apiSuccess } from '@/lib/server/api-response';
import {
  getServerWebSearchProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
} from '@/lib/server/provider-config';

const version = process.env.npm_package_version || '0.1.0';

export async function GET() {
  return apiSuccess({
    status: 'ok',
    version,
    capabilities: {
      // A capability is available only when at least one provider is enabled —
      // force-disabled providers (disabled: true) do not count (#665).
      webSearch: Object.values(getServerWebSearchProviders()).some((info) => !info.disabled),
      imageGeneration: Object.values(getServerImageProviders()).some((info) => !info.disabled),
      videoGeneration: Object.values(getServerVideoProviders()).some((info) => !info.disabled),
      tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
    },
  });
}
