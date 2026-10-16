/**
 * The deployment layer for slot resolution (RFC #1701, tracked in #1725).
 *
 * `openmaic.yml` (or the file named by OPENMAIC_CONFIG) is the deployment
 * layer when it exists. Otherwise providers, DEFAULT_MODEL and MODEL_FALLBACK
 * are translated into one (see legacy-config.ts): its assignments are server
 * defaults, exactly as `slots` in the file are, and it locks nothing.
 * MODEL_ROUTES is not translated: a deployment that sets it without
 * openmaic.yml gets an error asking for the file.
 */
import {
  getServerProviderConfig,
  providerModelsSetting,
  type ServerConfig,
  type ServerProviderEntry,
} from '@/lib/server/provider-config';
import { WEB_SEARCH_PROVIDERS } from '@/lib/web-search/constants';
import type { ModelConfigFile } from './openmaic-yml';
import { translateLegacyConfig } from '@/lib/server/model-config/legacy-config';
import { loadModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import { presetIdFor } from '@/lib/config/preset-ids';
import { usesServerCredentials, selectsUpstreamModel } from './model-authorization';
import { getProviderPreset } from '@/lib/config/provider-presets';
import type { SlotCapability } from '@/lib/config/model-slots';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

export interface DeploymentLayer {
  /** Providers, server defaults and locks: openmaic.yml, or the legacy configuration. */
  layer: ModelConfigLayer | null;
  /**
   * The layer was translated from the legacy variables: media routes keep
   * applying the legacy model pins to what it assigns.
   */
  legacy: boolean;
  /** How the layer was built, and what did not carry over. */
  notices: string[];
}

export class LegacyRoutesError extends Error {
  constructor() {
    super(
      'MODEL_ROUTES does not carry over to the model configuration: write the per-stage models as slots in openmaic.yml (or the file named by OPENMAIC_CONFIG) and remove MODEL_ROUTES',
    );
    this.name = 'LegacyRoutesError';
  }
}

function hasLegacyConfiguration(): boolean {
  const server = getServerProviderConfig();
  const sections = [
    server.providers,
    server.tts,
    server.asr,
    server.pdf,
    server.image,
    server.video,
    server.webSearch,
  ];
  return (
    sections.some((section) => Object.keys(section).length > 0) ||
    Object.values(server.disabled).some((ids) => ids.size > 0) ||
    !!process.env.DEFAULT_MODEL?.trim() ||
    !!process.env.MODEL_ROUTES?.trim() ||
    !!process.env.MODEL_FALLBACK?.trim()
  );
}

/** Explain why a legacy search opt-in cannot fill an unassigned file-backed slot. */
function ignoredSearchOptInNotices(file: ModelConfigFile): string[] {
  if (file.slots?.webSearch !== undefined) return [];
  const server = getServerProviderConfig();
  return Object.values(WEB_SEARCH_PROVIDERS)
    .filter(
      (provider) =>
        provider.enableEnvVar &&
        process.env[provider.enableEnvVar]?.trim() &&
        server.webSearch[provider.id] &&
        !server.disabled.webSearch.has(provider.id),
    )
    .map(
      (provider) =>
        `${provider.enableEnvVar} is set but openmaic.yml is present; declare a provider with preset: ${provider.sharedChatProviderId ?? provider.id} and assign slots.webSearch to that provider to use ${provider.name} search`,
    );
}

/**
 * Reads the process environment and working directory, like the legacy
 * loaders it translates (which cache what they read). Throws
 * LegacyRoutesError for MODEL_ROUTES without openmaic.yml.
 */
export function loadDeploymentLayer(): DeploymentLayer {
  const file = loadModelConfigFile();
  const legacy = hasLegacyConfiguration();
  if (file) {
    return {
      layer: { source: 'deployment', config: file },
      legacy: false,
      notices: [
        ...ignoredSearchOptInNotices(file),
        ...(legacy
          ? [
              'openmaic.yml is present, so slot resolution uses it and not the legacy provider variables, server-providers.yml, DEFAULT_MODEL, MODEL_ROUTES or MODEL_FALLBACK',
            ]
          : []),
        ...Object.entries(file.providers ?? {})
          .filter(
            ([, provider]) =>
              usesServerCredentials(provider) &&
              Object.keys(getProviderPreset(provider.preset)?.capabilities ?? {}).some(
                (capability) => selectsUpstreamModel(provider.preset, capability as SlotCapability),
              ) &&
              !provider.models?.length,
          )
          .map(
            ([id]) =>
              `Server-managed provider "${id}" has no explicit model list. Set openmaic.yml providers.${id}.models; only default/fallback models are usable.`,
          ),
      ],
    };
  }
  if (!legacy) return { layer: null, legacy: false, notices: [] };
  if (process.env.MODEL_ROUTES?.trim()) throw new LegacyRoutesError();
  const { config, notices } = translateLegacyConfig(getServerProviderConfig(), {
    defaultModel: process.env.DEFAULT_MODEL?.trim() || undefined,
    globalFallback: process.env.MODEL_FALLBACK?.trim() || undefined,
    defaultImageProvider: process.env.DEFAULT_IMAGE_PROVIDER?.trim() || undefined,
  });
  return {
    layer: config.providers || config.slots ? { source: 'deployment', config } : null,
    legacy: true,
    notices: [
      'The model configuration comes from the legacy provider variables, server-providers.yml, DEFAULT_MODEL and MODEL_FALLBACK, which are deprecated; move it to openmaic.yml',
      ...notices,
      ...Object.entries(getServerProviderConfig()).flatMap(([section, entries]) =>
        section === 'disabled' || section === 'pdf'
          ? []
          : Object.entries(entries as Record<string, ServerProviderEntry>)
              .filter(
                ([id, entry]) =>
                  selectsUpstreamModel(
                    presetIdFor(section === 'providers' ? 'chat' : (section as SlotCapability), id),
                    section === 'providers' ? 'chat' : (section as SlotCapability),
                  ) &&
                  (entry.apiKey ||
                    entry.accessKeyId ||
                    (section === 'providers' && id === 'bedrock')) &&
                  !entry.models?.length,
              )
              .map(
                ([id]) =>
                  `Server-managed provider "${section}.${id}" has no explicit model list. Set ${providerModelsSetting(section as keyof Omit<ServerConfig, 'disabled'>, id)}; only default/fallback models are usable.`,
              ),
      ),
    ],
  };
}
