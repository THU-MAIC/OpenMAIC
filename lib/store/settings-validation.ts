/**
 * Provider selection validation utilities.
 *
 * Pure functions used by fetchServerProviders() to detect and fix
 * stale provider/model selections after server config changes.
 */

export type ProviderCfgLike = {
  isServerConfigured?: boolean;
  requiresApiKey?: boolean;
  apiKey?: string;
};

// Stub implementations — tests should fail on assertions, not on import

export function isProviderUsable(_cfg: ProviderCfgLike | undefined): boolean {
  return false;
}

export function validateProvider<T extends string>(
  _currentId: T | '',
  _configMap: Partial<Record<T, ProviderCfgLike>>,
  _fallbackOrder: T[],
): T | '' {
  return '' as T;
}

export function validateModel(
  _currentModelId: string,
  _availableModels: Array<{ id: string }>,
): string {
  return '';
}
