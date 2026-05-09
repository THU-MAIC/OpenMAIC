/**
 * Web Search Provider Constants
 */

import type { WebSearchProviderId, WebSearchProviderConfig } from './types';

/**
 * Web Search Provider Registry
 */
export const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderId, WebSearchProviderConfig> = {
  tavily: {
    id: 'tavily',
    name: 'Tavily',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.tavily.com',
    endpointPath: '/search',
    icon: '/logos/tavily.svg',
  },
  bocha: {
    id: 'bocha',
    name: 'Bocha',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.bocha.cn',
    endpointPath: '/v1/web-search',
    icon: '/logos/bocha.png',
  },
};

export function getWebSearchProviderDisplayName(
  providerId: WebSearchProviderId,
  t?: (key: string) => string,
): string {
  const provider = WEB_SEARCH_PROVIDERS[providerId];
  if (!provider) return providerId;

  if (t) {
    const key = `settings.providerNames.${providerId}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }

  return provider.name;
}

/**
 * Get all available web search providers
 */
export function getAllWebSearchProviders(): WebSearchProviderConfig[] {
  return Object.values(WEB_SEARCH_PROVIDERS);
}
