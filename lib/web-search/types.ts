/**
 * Web Search Provider Type Definitions
 */

/**
 * Web Search Provider IDs
 */
export type WebSearchProviderId =
  | 'tavily'
  | 'exa'
  | 'firecrawl'
  | 'bocha'
  | 'brave'
  | 'baidu'
  | 'claude'
  | 'deepseek'
  | 'kimi'
  | 'minimax'
  | 'doubao'
  | 'searxng';

/**
 * Baidu sub-source toggles
 */
export interface BaiduSubSources {
  webSearch: boolean;
  baike: boolean;
  scholar: boolean;
}

/**
 * Web Search Provider Configuration
 */
export interface WebSearchProviderConfig {
  id: WebSearchProviderId;
  name: string;
  requiresApiKey: boolean;
  /** Chat account whose server credentials also serve this search provider. */
  sharedChatProviderId?: string;
  /** Explicit legacy opt-in before shared chat credentials activate search. */
  enableEnvVar?: string;
  /** Official account bases accepted by search settings and client requests. */
  officialBaseUrls?: readonly string[];
  /** Self-hosted instances need an explicit base URL (no public default). */
  requiresBaseUrl?: boolean;
  defaultBaseUrl?: string;
  endpointPath: string;
  icon?: string;
  /** The models a provider that searches through a model offers, best first. */
  models?: ReadonlyArray<{ id: string; name: string }>;
}
