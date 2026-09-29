/**
 * The deployment layer for slot resolution (RFC #1701, tracked in #1725).
 *
 * `openmaic.yml` (or the file named by OPENMAIC_CONFIG) is the deployment
 * layer when it exists. Otherwise providers, DEFAULT_MODEL and MODEL_FALLBACK
 * are translated into one (see legacy-config.ts). MODEL_ROUTES is not: a
 * deployment that sets it without openmaic.yml gets an error asking for the
 * file.
 */
import { getServerProviderConfig } from '@/lib/server/provider-config';
import { translateLegacyConfig } from '@/lib/server/model-config/legacy-config';
import { loadModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

export interface DeploymentLayer {
  /** Providers and locked assignments: openmaic.yml, or the legacy providers. */
  layer: ModelConfigLayer | null;
  /**
   * Assignments translated from DEFAULT_MODEL and MODEL_FALLBACK. They lock
   * nothing and rank below the workspace, as DEFAULT_MODEL used to rank below
   * the model a user picked.
   */
  defaults: ModelConfigLayer | null;
  /** How the layers were built, and what did not carry over. */
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
      defaults: null,
      notices: legacy
        ? [
            'openmaic.yml is present, so slot resolution uses it and not the legacy provider variables, server-providers.yml, DEFAULT_MODEL, MODEL_ROUTES or MODEL_FALLBACK',
          ]
        : [],
    };
  }
  if (!legacy) return { layer: null, defaults: null, notices: [] };
  if (process.env.MODEL_ROUTES?.trim()) throw new LegacyRoutesError();
  const { config, notices } = translateLegacyConfig(getServerProviderConfig(), {
    defaultModel: process.env.DEFAULT_MODEL?.trim() || undefined,
    globalFallback: process.env.MODEL_FALLBACK?.trim() || undefined,
    defaultImageProvider: process.env.DEFAULT_IMAGE_PROVIDER?.trim() || undefined,
  });
  return {
    layer: config.providers
      ? { source: 'deployment', config: { providers: config.providers } }
      : null,
    defaults: config.slots ? { source: 'default', config: { slots: config.slots } } : null,
    notices: [
      'The model configuration comes from the legacy provider variables, server-providers.yml, DEFAULT_MODEL and MODEL_FALLBACK, which are deprecated; move it to openmaic.yml',
      ...notices,
    ],
  };
}
