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
export interface WebSearchProviderConfig {
  id: WebSearchProviderId;
  name: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  icon?: string;
}
