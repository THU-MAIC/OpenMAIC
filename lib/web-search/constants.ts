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
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.minimaxi.com',
    endpointPath: '/v1/coding_plan/search',
    icon: '/logos/minimax.svg',
  },
  doubao: {
    id: 'doubao',
    name: 'Doubao',
    requiresApiKey: true,
    // 豆包搜索 Custom 版: the Agent Plan key authenticates directly here
    // (verified). The MCP/Skill path wraps this same REST endpoint.
    defaultBaseUrl: 'https://open.feedcoopapi.com',
    endpointPath: '/search_api/web_search',
    icon: '/logos/doubao.svg',
  },
  searxng: {
    id: 'searxng',
    name: 'SearXNG',
    requiresApiKey: false,
    requiresBaseUrl: true,
    endpointPath: '/search',
  },
};

export function isWebSearchProviderConfigured(
  provider: WebSearchProviderConfig,
  cfg?: { apiKey?: string; baseUrl?: string; isServerConfigured?: boolean },
): boolean {
  if (cfg?.isServerConfigured) return true;
  // SearXNG base URLs are operator-managed only; client settings must not count.
  if (provider.id === 'searxng') return false;
  if (provider.requiresApiKey) return !!cfg?.apiKey;
  if (provider.requiresBaseUrl) return !!cfg?.baseUrl;
  return true;
}

function isWebSearchConfigUsable(
  providerId: WebSearchProviderId,
  cfg?: {
    apiKey?: string;
    baseUrl?: string;
    isServerConfigured?: boolean;
    requiresApiKey?: boolean;
  },
): boolean {
  if (!cfg) return false;
  if (cfg.isServerConfigured) return true;

  const provider = WEB_SEARCH_PROVIDERS[providerId];
  if (providerId === 'searxng') return false;
  const requiresApiKey = cfg.requiresApiKey ?? provider.requiresApiKey;
  if (!requiresApiKey) {
    if (provider.requiresBaseUrl) return !!cfg.baseUrl;
    return true;
  }
  return !!cfg.apiKey;
}

/** Server-managed providers first, then other usable client providers. */
export function buildWebSearchFallbackOrder(
  config: Partial<
    Record<
      WebSearchProviderId,
      { apiKey?: string; baseUrl?: string; isServerConfigured?: boolean; requiresApiKey?: boolean }
    >
  >,
): WebSearchProviderId[] {
  const ids = Object.keys(WEB_SEARCH_PROVIDERS) as WebSearchProviderId[];
  const serverManaged = ids.filter(
    (id) => isWebSearchConfigUsable(id, config[id]) && config[id]?.isServerConfigured,
  );
  const clientUsable = ids.filter(
    (id) => isWebSearchConfigUsable(id, config[id]) && !config[id]?.isServerConfigured,
  );
  return [...serverManaged, ...clientUsable];
}

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
