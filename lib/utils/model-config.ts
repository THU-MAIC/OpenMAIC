import { useSettingsStore } from '@/lib/store/settings';
import { isLLMProviderConfigured } from '@/lib/store/settings-validation';
import {
  getThinkingConfigKey,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import { findModelById } from '@/lib/ai/model-aliases';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';

/**
 * Get current model configuration from settings store
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig, thinkingConfigs } = useSettingsStore.getState();
  const modelString = `${providerId}:${modelId}`;

  // Get current provider's config
  const providerConfig = providersConfig[providerId];
  const modelInfo = findModelById(providerId, providerConfig?.models, modelId);
  const thinking =
    modelInfo?.capabilities?.thinking ?? getCatalogThinkingCapability(providerId, modelId);
  const thinkingConfig = supportsConfigurableThinking(thinking)
    ? normalizeThinkingConfig(thinking, thinkingConfigs[getThinkingConfigKey(providerId, modelId)])
    : undefined;

  return {
    providerId,
    modelId,
    modelString,
    apiKey: providerConfig?.apiKey || '',
    baseUrl: providerConfig?.baseUrl || '',
    providerType: providerConfig?.type,
    requiresApiKey: providerConfig?.requiresApiKey,
    isServerConfigured: providerConfig?.isServerConfigured,
    thinkingConfig,
  };
}

/**
 * Serialize the user's per-stage LLM routes (settings store `llmStageRoutes`)
 * for the `x-model-routes` header, or `undefined` when no stage is routed.
 *
 * Each entry carries the routed provider's own connection params so the server
 * can build the model even when it differs from the main model's provider;
 * server-managed providers ignore the client credentials regardless.
 * Precedence server-side: operator MODEL_ROUTES > these routes > x-model.
 */
export function getStageRoutesHeaderValue(): string | undefined {
  const { llmStageRoutes, providersConfig } = useSettingsStore.getState();
  const entries = Object.entries(llmStageRoutes);
  if (entries.length === 0) return undefined;
  const routes: Record<string, unknown> = {};
  for (const [stage, selection] of entries) {
    const config = providersConfig[selection.providerId];
    // Belt for routes persisted before write-time pruning existed, and for
    // providers disabled/de-credentiailed through paths that bypass the store:
    // a route onto an unusable provider would make the server fail that stage
    // instead of falling back to the main model, so it is dropped here.
    if (!config || config.enabled === false || !isLLMProviderConfigured(config)) continue;
    routes[stage] = {
      model: `${selection.providerId}:${selection.modelId}`,
      apiKey: config?.apiKey || undefined,
      baseUrl: config?.baseUrl || undefined,
      providerType: config?.type,
      thinking: selection.thinking ?? undefined,
    };
  }
  if (Object.keys(routes).length === 0) return undefined;
  return JSON.stringify(routes);
}
