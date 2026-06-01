import { describe, expect, it } from 'vitest';
import {
  getAllWebSearchProviders,
  getWebSearchProviderDisplayName,
  WEB_SEARCH_PROVIDERS,
} from '@/lib/web-search/constants';

describe('web search provider constants', () => {
  it('uses translated provider names when available', () => {
    const t = (key: string) => (key === 'settings.providerNames.bocha' ? '博查' : key);

    expect(getWebSearchProviderDisplayName('bocha', t)).toBe('博查');
  });

  it('falls back to provider metadata name when no translation exists', () => {
    const t = (key: string) => key;

    expect(getWebSearchProviderDisplayName('tavily', t)).toBe('Tavily');
  });

  it('registers MiniMax as an API-key web search provider', () => {
    expect(WEB_SEARCH_PROVIDERS.minimax).toMatchObject({
      id: 'minimax',
      name: 'MiniMax',
      requiresApiKey: true,
      defaultBaseUrl: 'https://api.minimaxi.com',
      endpointPath: '/v1/coding_plan/search',
    });
    expect(getAllWebSearchProviders().map((provider) => provider.id)).toContain('minimax');
  });
});
