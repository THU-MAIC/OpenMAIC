/**
 * Providers whose language models the server builds itself, from an account it
 * signed in to rather than from a key. Their registry entries are marked
 * `serverAdapter` (`lib/ai/providers.ts`): `getModel` refuses them, and model
 * resolution, the model list and the settings come here instead.
 */
import type { LanguageModel } from 'ai';

import { chatGPTPlanAvailability } from '@/lib/server/chatgpt-plan/availability';
import type { ResolvedModel } from '@/lib/server/resolve-model';
import type { ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';

export interface ServerAdapterModel {
  id: string;
  name: string;
  contextWindow?: number;
  vision?: boolean;
  thinking?: ThinkingCapability;
}

export interface ServerLanguageModelAdapter {
  /** Why this installation cannot use the provider (caller-facing), or undefined. */
  problem(): string | undefined;
  languageModel(model: ServerAdapterModel): Promise<LanguageModel>;
  /** The models the signed-in account offers. */
  listModels(): Promise<ServerAdapterModel[]>;
}

// An adapter's model code loads when a model is built, not with model resolution.
const chatGPTPlanModels = () => import('@/lib/server/chatgpt-plan/model');

const ADAPTERS: Record<string, ServerLanguageModelAdapter> = {
  'chatgpt-plan': {
    problem() {
      const availability = chatGPTPlanAvailability();
      if (availability.available) return undefined;
      return availability.reason === 'disabled'
        ? 'The ChatGPT plan provider is turned off (OPENMAIC_CHATGPT_PLAN_ENABLED).'
        : 'The ChatGPT plan provider is available on personal installations only.';
    },
    languageModel: async (model) =>
      (await chatGPTPlanModels()).chatGPTPlanLanguageModel(model.id, model.thinking),
    listModels: async () => (await chatGPTPlanModels()).listChatGPTPlanModels(),
  },
};

export function serverLanguageModelAdapter(
  registryId: string,
): ServerLanguageModelAdapter | undefined {
  return Object.hasOwn(ADAPTERS, registryId) ? ADAPTERS[registryId] : undefined;
}

/**
 * A server adapter's model as model resolution answers it. Nothing a request
 * or configuration sends (a key, an endpoint, a proxy) applies to it.
 */
export async function serverAdapterModel(
  adapter: ServerLanguageModelAdapter,
  target: {
    registryId: string;
    modelId: string;
    thinkingConfig?: ThinkingConfig;
    contextWindow?: number;
  },
): Promise<ResolvedModel> {
  const problem = adapter.problem();
  if (problem) throw new ServerAdapterUnavailableError(problem);
  const { registryId, modelId, thinkingConfig, contextWindow } = target;
  const listed = (await adapter.listModels()).find((model) => model.id === modelId);
  if (!listed)
    throw new ServerAdapterUnavailableError(
      `Model ${modelId} is unavailable for the connected account. Refresh the model list in settings.`,
    );
  return {
    model: await adapter.languageModel(listed),
    modelInfo: {
      id: modelId,
      name: listed.name,
      contextWindow: contextWindow ?? listed.contextWindow,
      capabilities: { vision: listed.vision, thinking: listed.thinking },
    },
    modelString: `${registryId}:${modelId}`,
    providerId: registryId,
    modelId,
    apiKey: '',
    ...(thinkingConfig ? { thinkingConfig } : {}),
    serverManaged: true,
  };
}

/** The installation cannot use a server adapter's provider. */
export class ServerAdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerAdapterUnavailableError';
  }
}
