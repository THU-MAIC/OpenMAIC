import type { ProviderId, ModelInfo, ProviderType } from '@/lib/types/provider';

export type SettingsSection =
  | 'general'
  | 'token-plan'
  | 'providers'
  | 'agents'
  | 'tts'
  | 'asr'
  | 'pdf'
  | 'image'
  | 'video'
  | 'web-search';

/**
 * Unified provider configuration stored in JSON format
 * Stores all provider-specific settings and metadata in one object
 * Both built-in and custom providers use the same structure
 */
export interface ProviderSettings {
  // Configuration
  apiKey: string;
  baseUrl: string;
  models: ModelInfo[]; // All models (user can edit/delete any)

  // Metadata (same for built-in and custom providers)
  name: string;
  type: ProviderType;
  defaultBaseUrl?: string;
  icon?: string;
  requiresApiKey: boolean;
  isBuiltIn: boolean; // true for built-in providers, false for custom

  // Optional explicit /models URL override for model probing (from a preset, or
  // when the vendor's model-list path is non-standard). Empty = auto candidates.
  modelsUrl?: string;

  // Server-side configuration (set by fetchServerProviders).
  // A server-configured provider is admin-managed: the operator owns its key
  // and base URL, and the client cannot override them. The server base URL is
  // deliberately NOT exposed to the client.
  isServerConfigured?: boolean; // Server manages this provider's credentials
  serverModels?: string[]; // Server-restricted model list (if set)
}

/**
 * Provider configurations storage format
 * Key: providerId, Value: ProviderSettings
 */
export type ProvidersConfig = Record<ProviderId, ProviderSettings>;

export interface EditingModel {
  providerId: ProviderId;
  modelIndex: number | null; // null for new model
  model: ModelInfo;
}
