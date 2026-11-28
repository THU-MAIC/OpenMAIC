import type { ModelInfo, ThinkingCapability } from '@/lib/types/provider';
import type { ModelSettingsView } from './client';

/** A model returned by a signed-in account's discovery endpoint. */
export interface AccountModel {
  id: string;
  name: string;
  contextWindow?: number;
  vision?: boolean;
  thinking?: ThinkingCapability;
}

export function accountModelInfo(model: AccountModel, contextWindow?: number): ModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: contextWindow ?? model.contextWindow,
    capabilities: { vision: model.vision, thinking: model.thinking },
  };
}

/** Add catalogue details to the saved choices; settings stay usable when discovery fails. */
export async function loadAccountModelDetails(
  view: ModelSettingsView,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<ModelSettingsView | undefined> {
  const lists = new Map<string, Promise<AccountModel[] | undefined>>();
  async function read(url: string) {
    try {
      const response = await fetchImpl(url, { cache: 'no-store' });
      if (!response.ok) return;
      const result = await response.json();
      return result.success && Array.isArray(result.models)
        ? (result.models as AccountModel[])
        : undefined;
    } catch {
      return undefined;
    }
  }
  const providers = await Promise.all(
    view.providers.map(async (provider) => {
      const chat = provider.capabilities.chat;
      const url = provider.accountModelsUrl;
      if (!url || !chat?.models.length) return provider;
      if (!lists.has(url)) lists.set(url, read(url));
      const catalogue = await lists.get(url)!;
      if (!catalogue) return provider;
      const models = chat.models.flatMap((row) => {
        const listed = catalogue.find(({ id }) => id === row.id);
        return listed ? [accountModelInfo(listed, row.contextWindow)] : [];
      });
      return { ...provider, capabilities: { ...provider.capabilities, chat: { ...chat, models } } };
    }),
  );
  if (providers.some((provider, i) => provider !== view.providers[i]))
    return { ...view, providers };
}
