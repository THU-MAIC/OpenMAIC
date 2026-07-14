/**
 * Web Search Provider Type Definitions
 */

/**
 * Web Search Provider IDs
 */
export type WebSearchProviderId =
  | 'tavily'
  | 'bocha'
  | 'brave'
  | 'baidu'
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
  /** Self-hosted instances need an explicit base URL (no public default). */
  requiresBaseUrl?: boolean;
  defaultBaseUrl?: string;
  endpointPath: string;
  icon?: string;
}
