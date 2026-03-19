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
    icon: '/icons/tavily.jpg',
  },
  brave: {
    id: 'brave',
    name: 'Brave Search',
    requiresApiKey: false,
    defaultBaseUrl: 'https://search.brave.com',
    icon: '/icons/brave.png',
  },
  baidu: {
    id: 'baidu',
    name: 'Baidu',
    requiresApiKey: true,
    defaultBaseUrl: 'https://qianfan.baidubce.com',
    icon: '/icons/baidu.png',
  },
};

/**
 * Baidu sub-source labels (for settings UI)
 */
export const BAIDU_SUB_SOURCES = {
  webSearch: { label: { 'zh-CN': '网页搜索', 'en-US': 'Web Search' }, emoji: '🌐' },
  baike: { label: { 'zh-CN': '百度百科', 'en-US': 'Baidu Baike' }, emoji: '📖' },
  scholar: { label: { 'zh-CN': '百度学术', 'en-US': 'Baidu Scholar' }, emoji: '🔬' },
} as const;

/**
 * Get all available web search providers
 */
export function getAllWebSearchProviders(): WebSearchProviderConfig[] {
  return Object.values(WEB_SEARCH_PROVIDERS);
}
