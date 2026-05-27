/**
 * Web Search Provider Constants
 */

import type { BaiduSubSources, WebSearchProviderId, WebSearchProviderConfig } from './types';

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
  brave: {
    id: 'brave',
    name: 'Brave Search',
    requiresApiKey: false,
    defaultBaseUrl: 'https://search.brave.com',
    endpointPath: '/search',
    icon: '/logos/brave.png',
  },
  baidu: {
    id: 'baidu',
    name: 'Baidu',
    requiresApiKey: true,
    defaultBaseUrl: 'https://qianfan.baidubce.com',
    endpointPath: '/v2/ai_search/web_search',
    icon: '/logos/baidu.png',
  },
};

export const BAIDU_SUB_SOURCES: Record<
  keyof BaiduSubSources,
  { labelKey: string; descriptionKey: string; docsUrl?: string }
> = {
  webSearch: {
    labelKey: 'settings.baiduSubSourceWeb',
    descriptionKey: 'settings.baiduSubSourceWebDescription',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan/s/Mmh4sv6ec',
  },
  baike: {
    labelKey: 'settings.baiduSubSourceBaike',
    descriptionKey: 'settings.baiduSubSourceBaikeDescription',
    docsUrl: 'https://ai.baidu.com/ai-doc/AppBuilder/rmckc6mtu',
  },
  scholar: {
    labelKey: 'settings.baiduSubSourceScholar',
    descriptionKey: 'settings.baiduSubSourceScholarDescription',
    docsUrl: 'https://cloud.baidu.com/doc/qianfan/s/Amkw9qpzd',
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
