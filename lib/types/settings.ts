import type { ProviderId, ModelInfo, ProviderType } from '@/lib/types/provider';

export type SettingsSection =
  | 'general'
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

  // Server-side configuration (set by fetchServerProviders)
  isServerConfigured?: boolean; // Server has API key for this provider
  serverModels?: string[]; // Server-restricted model list (if set)
  serverBaseUrl?: string; // Server-provided base URL override
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
