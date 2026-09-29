/**
 * The deployment layer for slot resolution (RFC #1701, tracked in #1725).
 *
 * `openmaic.yml` (or the file named by OPENMAIC_CONFIG) is the deployment
 * layer when it exists. Otherwise the legacy configuration (provider variables,
 * `server-providers.yml`, DEFAULT_MODEL, MODEL_ROUTES, MODEL_FALLBACK) is
 * translated into one, so existing deployments resolve the same way without
 * changing anything.
 */
import {
  LLM_STAGES,
  getStageRoute,
  type LlmStage,
  type StageRoute,
} from '@/lib/server/model-routes';
import { getServerProviderConfig } from '@/lib/server/provider-config';
import { translateLegacyConfig } from '@/lib/server/model-config/legacy-config';
import { loadModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

export interface DeploymentLayer {
  layer: ModelConfigLayer | null;
  /** How the layer was built, and what did not carry over. */
  notices: string[];
}

function effectiveStageRoutes(): Partial<Record<LlmStage, StageRoute>> {
  const routes: Partial<Record<LlmStage, StageRoute>> = {};
  for (const stage of LLM_STAGES) {
    const route = getStageRoute(stage);
    if (route) routes[stage] = route;
  }
  return routes;
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
 * loaders it translates (which cache what they read).
 */
export function loadDeploymentLayer(): DeploymentLayer {
  const file = loadModelConfigFile();
  const legacy = hasLegacyConfiguration();
  if (file) {
    return {
      layer: { source: 'deployment', config: file },
      notices: legacy
        ? [
            'openmaic.yml is present, so slot resolution uses it and not the legacy provider variables, server-providers.yml, DEFAULT_MODEL, MODEL_ROUTES or MODEL_FALLBACK',
          ]
        : [],
    };
  }
  if (!legacy) return { layer: null, notices: [] };
  const { config, notices } = translateLegacyConfig(getServerProviderConfig(), {
    defaultModel: process.env.DEFAULT_MODEL?.trim() || undefined,
    stageRoutes: effectiveStageRoutes(),
    globalFallback: process.env.MODEL_FALLBACK?.trim() || undefined,
  });
  const empty = !config.providers && !config.slots;
  return {
    layer: empty ? null : { source: 'deployment', config },
    notices: [
      'The model configuration comes from the legacy provider variables, server-providers.yml, DEFAULT_MODEL, MODEL_ROUTES and MODEL_FALLBACK, which are deprecated; move it to openmaic.yml',
      ...notices,
    ],
  };
}
