/**
 * Providers whose language models the server builds itself, from an account it
 * signed in to rather than from a key. Their registry entries are marked
 * `serverAdapter` (`lib/ai/providers.ts`): `getModel` refuses them, and model
 * resolution, the model list and the settings come here instead.
 */
import type { LanguageModel } from 'ai';

import { markPublicProviderFailure } from '@/lib/server/llm-error-response';
import { chatGPTPlanAvailability } from '@/lib/server/chatgpt-plan/availability';
import type { ResolvedModel } from '@/lib/server/resolve-model';
import type { ThinkingConfig } from '@/lib/types/provider';
import { accountModelInfo, type AccountModel } from '@/lib/model-settings/account-models';
import { CHATGPT_PLAN_API } from '@/lib/chatgpt-plan/shared';

export interface ServerLanguageModelAdapter {
  /** Why this installation cannot use the provider (caller-facing), or undefined. */
  problem(): string | undefined;
  languageModel(model: AccountModel): Promise<LanguageModel>;
  /** The owner's endpoint for refreshing the catalogue in settings. */
  modelsUrl: string;
  /** Recovery text when an assigned model disappears from this account. */
  modelUnavailableKey: string;
  /** The models the signed-in account offers. */
  listModels(): Promise<AccountModel[]>;
}

// An adapter's model code loads when a model is built, not with model resolution.
const chatGPTPlanModels = () => import('@/lib/server/chatgpt-plan/model');

const ADAPTERS: Record<string, ServerLanguageModelAdapter> = {
  'chatgpt-plan': {
    modelsUrl: CHATGPT_PLAN_API.models,
    modelUnavailableKey: 'settings.chatgptPlan.modelUnavailable',
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
  if (problem) throw markPublicProviderFailure(new Error(problem), 403, 'unavailable');
  const { registryId, modelId, thinkingConfig, contextWindow } = target;
  const listed = (await adapter.listModels()).find((model) => model.id === modelId);
  if (!listed)
    throw markPublicProviderFailure(
      new Error(
        'The selected model is unavailable for the connected account. Refresh the model list in settings.',
      ),
      400,
      'model-unavailable',
      adapter.modelUnavailableKey,
    );
  return {
    model: await adapter.languageModel(listed),
    modelInfo: accountModelInfo(listed, contextWindow),
    modelString: `${registryId}:${modelId}`,
    providerId: registryId,
    modelId,
    apiKey: '',
    ...(thinkingConfig ? { thinkingConfig } : {}),
    serverManaged: true,
  };
}
