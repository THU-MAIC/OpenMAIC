import { getModel, getModelInfo, type ModelWithInfo } from '@/lib/ai/providers';
import type { ModelConfig } from '@/lib/types/provider';
import { createCodexLanguageModel } from '@/lib/server/codex/language-model';

type ServerLanguageModelFactory = (config: ModelConfig) => ModelWithInfo;

const SERVER_LANGUAGE_MODEL_FACTORIES: Record<string, ServerLanguageModelFactory> = {
  codex: (config) => ({
    model: createCodexLanguageModel(config.modelId),
    modelInfo: getModelInfo(config.providerId, config.modelId) ?? null,
  }),
};

/**
 * Resolve server-only model transports before falling back to the universal
 * provider registry used by both server and browser settings code.
 */
export function createServerLanguageModel(config: ModelConfig): ModelWithInfo {
  return SERVER_LANGUAGE_MODEL_FACTORIES[config.providerId]?.(config) ?? getModel(config);
}
