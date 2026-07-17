import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '@/lib/ai/providers';
import { getCatalogThinkingCapability, getModelMetadataKey } from '@/lib/ai/model-metadata';
import type { ProviderConfig, ProviderId } from '@/lib/types/provider';

// These models intentionally do not expose a configurable thinking control.
const MODELS_WITHOUT_CONFIGURABLE_THINKING = new Set<string>([
  'siliconflow:Pro/moonshotai/Kimi-K2.5',
  'grok:grok-4.20',
  'grok:grok-4-1-fast-non-reasoning',
  'grok:grok-code-fast-1',
  'ollama:llama3.3',
  'ollama:gemma3',
  'ollama:deepseek-r1',
]);

function findDriftedModels(providers: Record<ProviderId, ProviderConfig>): string[] {
  const driftedModels: string[] = [];

  for (const provider of Object.values(providers)) {
    for (const model of provider.models) {
      const key = getModelMetadataKey(provider.id, model.id);

      if (getCatalogThinkingCapability(provider.id, model.id)) {
        continue;
      }

      if (MODELS_WITHOUT_CONFIGURABLE_THINKING.has(key)) {
        continue;
      }

      driftedModels.push(key);
    }
  }

  return driftedModels;
}

describe('model metadata thinking capabilities', () => {
  it('accounts for every PROVIDERS model with a capability or explicit non-thinking allowlist', () => {
    expect(findDriftedModels(PROVIDERS)).toEqual([]);
  });

  it('catches drift when a provider model has no thinking metadata or allowlist entry', () => {
    const syntheticProviders = {
      siliconflow: {
        ...PROVIDERS.siliconflow,
        models: [
          ...PROVIDERS.siliconflow.models,
          { id: '__synthetic_missing__', name: 'x', capabilities: {} },
        ],
      },
    } as Record<ProviderId, ProviderConfig>;

    expect(findDriftedModels(syntheticProviders)).toContain('siliconflow:__synthetic_missing__');
  });

  it('resolves thinking capabilities for the previously missing explicit models', () => {
    expect(getCatalogThinkingCapability('siliconflow', 'deepseek-ai/DeepSeek-V3.2')).toBeDefined();
    expect(getCatalogThinkingCapability('lemonade', 'Gemma-4-26B-A4B-it-GGUF')).toBeDefined();
  });

  it('resolves GPT-5.6 Sol alias metadata through the canonical model ID', () => {
    expect(getCatalogThinkingCapability('openai', 'gpt-5.6-sol')).toEqual(
      getCatalogThinkingCapability('openai', 'gpt-5.6'),
    );
  });
});
