import { describe, expect, it, vi, beforeEach } from 'vitest';

describe('server web search config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    delete process.env.BOCHA_API_KEY;
    delete process.env.BOCHA_BASE_URL;
    delete process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_BASE_URL;
    delete process.env.BAIDU_API_KEY;
    delete process.env.BAIDU_BASE_URL;
  });

  it('rejects client-controlled base URLs outside the provider allowlist', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(() =>
      resolveSafeClientWebSearchBaseUrl('bocha', 'http://127.0.0.1:3000/internal'),
    ).toThrow('Unsupported Bocha base URL');
  });

  it('allows official Bocha client base URLs', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(resolveSafeClientWebSearchBaseUrl('bocha', 'https://api.bochaai.com/v1')).toBe(
      'https://api.bochaai.com/v1',
    );
  });

  it('resolves classroom web search config from selected provider and client key', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'bocha',
        webSearchApiKey: 'bocha-client-key',
      }),
    ).toEqual({
      providerId: 'bocha',
      apiKey: 'bocha-client-key',
      baseUrl: undefined,
    });
  });

  it('uses server base URL for classroom web search config instead of client-controlled URLs', async () => {
    vi.stubEnv('BOCHA_API_KEY', 'bocha-server-key');
    vi.stubEnv('BOCHA_BASE_URL', 'http://internal-proxy.local/bocha');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(resolveClassroomWebSearchConfig({ webSearchProviderId: 'bocha' })).toEqual({
      providerId: 'bocha',
      apiKey: 'bocha-server-key',
      baseUrl: 'http://internal-proxy.local/bocha',
    });
  });

  it('resolves Brave classroom web search config without an API key', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(resolveClassroomWebSearchConfig({ webSearchProviderId: 'brave' })).toEqual({
      providerId: 'brave',
      apiKey: '',
      baseUrl: undefined,
    });
  });

  it('keeps Baidu sub-source toggles in classroom web search config', async () => {
    vi.stubEnv('BAIDU_API_KEY', 'baidu-server-key');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'baidu',
        baiduSubSources: { webSearch: false, baike: true, scholar: false },
      }),
    ).toEqual({
      providerId: 'baidu',
      apiKey: 'baidu-server-key',
      baseUrl: undefined,
      baiduSubSources: { webSearch: false, baike: true, scholar: false },
    });
  });
});
