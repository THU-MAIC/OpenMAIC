/**
 * Web Search Provider Type Definitions
 */

/**
 * Web Search Provider IDs
 */
export type WebSearchProviderId = 'tavily' | 'claude';

/**
 * Web Search Provider Configuration
 */
export interface WebSearchModel {
  id: string;
  name: string;
}

export interface WebSearchProviderConfig {
  id: WebSearchProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  icon?: string;
  models?: WebSearchModel[];
}
