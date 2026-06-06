/**
 * Provider selection validation utilities.
 *
 * Pure functions used by fetchServerProviders() to detect and fix
 * stale provider/model selections after server config changes.
 */

export type ProviderCfgLike = {
  isServerConfigured?: boolean;
  apiKey?: string;
  requiresApiKey?: boolean;
  baseUrl?: string;
  /** Operator force-disabled (server precedence, TTS — #665). Never usable. */
  serverDisabled?: boolean;
};

/**
 * Check whether a provider has a usable *credential path* (server config or
 * client key/baseUrl). This is the store-level notion and deliberately does
 * NOT require ≥1 model — the UX-level "usable" predicate
 * ({@link isLLMProviderConfigured}) additionally requires a model, so a
 * pathological zero-model provider is classified State A at the UI boundary
 * even though the store may keep it selected with an empty model (#580).
 */
export function isProviderUsable(cfg: ProviderCfgLike | undefined): boolean {
  if (!cfg) return false;
  // Operator force-disable wins over any local credential path so the current
  // selection is re-pointed away from a server-disabled provider (#665).
  if (cfg.serverDisabled) return false;
  if (cfg.isServerConfigured) return true;
  // Keyless providers (e.g. Ollama) need an explicit user-provided baseUrl
  if (cfg.requiresApiKey === false) return !!cfg.baseUrl;
  return !!cfg.apiKey;
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

/**
 * Resolve the model selection for a usable provider.
 *
 * Enforces the invariant "usable provider ⇒ a concrete model is selected":
 * keeps the current model if still valid, otherwise falls back to the first
 * available model. Unlike {@link validateModel} it has no empty-input
 * short-circuit, so it returns '' ONLY when the model list is empty (i.e. the
 * provider is not usable). Use this for model *selection resolution*; use
 * validateModel only for pure validation.
 */
export function resolveSelectedModel(
  currentModelId: string,
  availableModels: Array<{ id: string }>,
): string {
  if (availableModels.some((m) => m.id === currentModelId)) return currentModelId;
  return availableModels[0]?.id ?? '';
}

export interface LLMProviderCfgLike {
  requiresApiKey?: boolean;
  apiKey?: string;
  isServerConfigured?: boolean;
  models: Array<{ id: string }>;
  baseUrl?: string;
  defaultBaseUrl?: string;
}

/**
 * Canonical "this LLM provider is usable" predicate — single source of truth
 * shared by the generation toolbar selector and the landing-page generate
 * gate (#580). Deliberately consistent with {@link isProviderUsable} so the
 * gate/toolbar can never claim a provider is usable when the server-sync
 * reconcile would not actually select it:
 *
 * - server-configured ⇒ usable;
 * - keyless provider (ollama/lemonade) ⇒ usable ONLY once the user sets an
 *   explicit baseUrl — the registry `defaultBaseUrl` alone is not user intent;
 * - key-requiring provider ⇒ needs a client key AND a resolvable endpoint.
 *
 * Always also requires ≥1 model.
 */
export function isLLMProviderConfigured(config: LLMProviderCfgLike): boolean {
  if (config.models.length < 1) return false;
  if (config.isServerConfigured) return true;
  if (config.requiresApiKey === false) return !!config.baseUrl;
  if (!config.apiKey) return false;
  return !!(config.baseUrl || config.defaultBaseUrl);
}

/**
 * Whether at least one LLM provider is usable — i.e. the app is in state B
 * (≥1 usable provider) rather than state A (must configure a provider). Under
 * the #580 invariant this is exactly the condition under which a concrete
 * model is guaranteed to be selected.
 */
export function hasUsableLLMProvider(
  providersConfig: Record<string, LLMProviderCfgLike> | undefined | null,
): boolean {
  if (!providersConfig) return false;
  return Object.values(providersConfig).some(isLLMProviderConfigured);
}
