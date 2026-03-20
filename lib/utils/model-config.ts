import { useSettingsStore } from '@/lib/store/settings';

/**
 * Get current model configuration from settings store
 */
export function getCurrentModelConfig() {
  const { providerId, modelId, providersConfig } = useSettingsStore.getState();
  const modelString = `${providerId}:${modelId}`;

  // Get current provider's config
  const providerConfig = providersConfig[providerId];

  return {
    providerId,
    modelId,
    modelString,
    apiKey: providerConfig?.apiKey || '',
    baseUrl: providerConfig?.baseUrl || '',
    providerType: providerConfig?.type,
    requiresApiKey: providerConfig?.requiresApiKey,
    isServerConfigured: providerConfig?.isServerConfigured,
  };
}

/**
 * Maps a TTS provider ID to the corresponding LLM provider ID so we can
 * fall back to the main API key when no TTS-specific key is set.
 */
const TTS_PROVIDER_TO_LLM: Record<string, string> = {
  'openai-tts': 'openai',
  'glm-tts': 'glm',
  'qwen-tts': 'qwen',
  'google-tts': 'google',
};

/**
 * Maps an ASR provider ID to the corresponding LLM provider ID.
 */
const ASR_PROVIDER_TO_LLM: Record<string, string> = {
  'openai-whisper': 'openai',
  'qwen-asr': 'qwen',
};

/**
 * Returns the effective TTS API key:
 * - Uses the TTS-provider-specific key if one is set, OR
 * - Falls back to the matching LLM provider's key (e.g. openai-tts → openai key)
 * so users only have to enter one API key to get everything working.
 */
export function getEffectiveTTSApiKey(ttsProviderId: string): string | undefined {
  const { ttsProvidersConfig, providersConfig } = useSettingsStore.getState();
  const ttsKey = ttsProvidersConfig?.[ttsProviderId as keyof typeof ttsProvidersConfig]?.apiKey;
  if (ttsKey?.trim()) return ttsKey;

  const llmProviderId = TTS_PROVIDER_TO_LLM[ttsProviderId];
  if (llmProviderId) {
    const llmKey = providersConfig?.[llmProviderId as keyof typeof providersConfig]?.apiKey;
    if (llmKey?.trim()) return llmKey;
  }
  return undefined;
}

/**
 * Returns the effective ASR API key with the same fallback logic as TTS.
 */
export function getEffectiveASRApiKey(asrProviderId: string): string | undefined {
  const { asrProvidersConfig, providersConfig } = useSettingsStore.getState();
  const asrKey = asrProvidersConfig?.[asrProviderId as keyof typeof asrProvidersConfig]?.apiKey;
  if (asrKey?.trim()) return asrKey;

  const llmProviderId = ASR_PROVIDER_TO_LLM[asrProviderId];
  if (llmProviderId) {
    const llmKey = providersConfig?.[llmProviderId as keyof typeof providersConfig]?.apiKey;
    if (llmKey?.trim()) return llmKey;
  }
  return undefined;
}
