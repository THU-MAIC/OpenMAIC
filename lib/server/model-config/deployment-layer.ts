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
import { loadModelConfigFile, type ConfigEnv } from '@/lib/server/model-config/openmaic-yml';
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

function hasLegacyConfiguration(env: ConfigEnv): boolean {
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
    !!env.DEFAULT_MODEL?.trim() ||
    !!env.MODEL_ROUTES?.trim() ||
    !!env.MODEL_FALLBACK?.trim()
  );
}

export function loadDeploymentLayer(
  env: ConfigEnv = process.env,
  cwd: string = process.cwd(),
): DeploymentLayer {
  const file = loadModelConfigFile(env, cwd);
  if (file) {
    return {
      layer: { source: 'deployment', config: file },
      notices: hasLegacyConfiguration(env)
        ? [
            'openmaic.yml is present, so slot resolution uses it and not the legacy provider variables, server-providers.yml, DEFAULT_MODEL, MODEL_ROUTES or MODEL_FALLBACK',
          ]
        : [],
    };
  }
  const { config, notices } = translateLegacyConfig(getServerProviderConfig(), {
    defaultModel: env.DEFAULT_MODEL?.trim() || undefined,
    stageRoutes: effectiveStageRoutes(),
    globalFallback: env.MODEL_FALLBACK?.trim() || undefined,
  });
  const empty = !config.providers && !config.slots;
  return { layer: empty ? null : { source: 'deployment', config }, notices };
}
