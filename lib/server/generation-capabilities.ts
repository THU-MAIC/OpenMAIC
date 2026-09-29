import {
  getServerImageProviders,
  getServerTTSProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
} from '@/lib/server/provider-config';

export interface ServerGenerationCapabilities {
  webSearch: boolean;
  imageGeneration: boolean;
  videoGeneration: boolean;
  tts: boolean;
}

/**
 * The optional generation capabilities this server can run, derived from its
 * provider configuration. `GET /api/health`, `GET /api/generate-classroom/capabilities`
 * and the classroom generation pipeline all read this one function, so what a
 * caller is told is available is exactly what a generation job uses.
 *
 * A capability is available only when at least one provider is enabled —
 * force-disabled providers (disabled: true) do not count (#665).
 *
 * This is the single place to switch to slot resolution once server-side model
 * configuration (#1701) lands.
 */
export function resolveServerGenerationCapabilities(): ServerGenerationCapabilities {
  return {
    webSearch: Object.values(getServerWebSearchProviders()).some((info) => !info.disabled),
    imageGeneration: Object.values(getServerImageProviders()).some((info) => !info.disabled),
    videoGeneration: Object.values(getServerVideoProviders()).some((info) => !info.disabled),
    tts: Object.values(getServerTTSProviders()).some((info) => !info.disabled),
  };
}
