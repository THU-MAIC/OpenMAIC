import { describe, expect, it } from 'vitest';
import {
  getAllWebSearchProviders,
  getWebSearchProviderDisplayName,
  WEB_SEARCH_PROVIDERS,
  buildWebSearchFallbackOrder,
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

  it('registers SearXNG as a base-URL-only web search provider', () => {
    expect(WEB_SEARCH_PROVIDERS.searxng).toMatchObject({
      id: 'searxng',
      name: 'SearXNG',
      requiresApiKey: false,
      requiresBaseUrl: true,
      endpointPath: '/search',
    });
    expect(getAllWebSearchProviders().map((provider) => provider.id)).toContain('searxng');
  });

  it('does not treat client-supplied SearXNG base URL as configured', () => {
    const order = buildWebSearchFallbackOrder({
      searxng: {
        apiKey: '',
        baseUrl: 'http://192.168.161.100:6060',
        requiresApiKey: false,
      },
      brave: { apiKey: '', requiresApiKey: false },
    });

    expect(order).not.toContain('searxng');
    expect(order).toContain('brave');
  });

  it('prioritizes server-managed web search providers in fallback order', () => {
    const order = buildWebSearchFallbackOrder({
      tavily: { apiKey: '', requiresApiKey: true },
      brave: { apiKey: '', baseUrl: 'https://search.brave.com', requiresApiKey: false },
      searxng: { apiKey: '', baseUrl: '', requiresApiKey: false, isServerConfigured: true },
    });

    expect(order[0]).toBe('searxng');
    expect(order).toContain('brave');
    expect(order.indexOf('searxng')).toBeLessThan(order.indexOf('brave'));
  });
});
