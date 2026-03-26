/**
 * Provider selection validation utilities.
 *
 * Pure functions used by fetchServerProviders() to detect and fix
 * stale provider/model selections after server config changes.
 */

export type ProviderCfgLike = {
  isServerConfigured?: boolean;
  apiKey?: string;
};

/** Check whether a provider has a usable path (server config or client key). */
export function isProviderUsable(cfg: ProviderCfgLike | undefined): boolean {
  if (!cfg) return false;
  return !!cfg.isServerConfigured || !!cfg.apiKey;
}

/**
 * Validate current provider selection against updated config.
 * Returns the current ID if still usable, otherwise the first usable
 * provider from fallbackOrder, or defaultId if provided, or ''.
 */
export function validateProvider<T extends string>(
  currentId: T | '',
  configMap: Partial<Record<T, ProviderCfgLike>>,
  fallbackOrder: T[],
  defaultId?: T,
): T | '' {
  if (!currentId) return currentId;
  if (isProviderUsable(configMap[currentId])) return currentId;

  for (const id of fallbackOrder) {
    if (isProviderUsable(configMap[id])) return id;
  }
  return defaultId ?? '';
}

/**
 * Validate current model selection against available models list.
 * Falls back to first available model, or '' if list is empty.
 */
export function validateModel(
  currentModelId: string,
  availableModels: Array<{ id: string }>,
): string {
  if (!currentModelId) return currentModelId;
  if (availableModels.some((m) => m.id === currentModelId)) return currentModelId;
  return availableModels[0]?.id ?? '';
}
