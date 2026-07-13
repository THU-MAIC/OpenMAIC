import { useSettingsStore } from '@/lib/store/settings';
import {
  getThinkingConfigKey,
  normalizeThinkingConfig,
  supportsConfigurableThinking,
} from '@/lib/ai/thinking-config';
import { getCanonicalModelId } from '@/lib/ai/model-aliases';
import { getCatalogThinkingCapability } from '@/lib/ai/model-metadata';

/**
 * Get current model configuration from settings store
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig, thinkingConfigs } = useSettingsStore.getState();
  const modelString = `${providerId}:${modelId}`;

  // Get current provider's config
  const providerConfig = providersConfig[providerId];
  const canonicalModelId = getCanonicalModelId(providerId, modelId);
  const modelInfo = providerConfig?.models.find(
    (model) => getCanonicalModelId(providerId, model.id) === canonicalModelId,
  );
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
