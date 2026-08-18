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
    delete process.env.WEB_SEARCH_MINIMAX_API_KEY;
    delete process.env.WEB_SEARCH_MINIMAX_BASE_URL;
    delete process.env.WEB_SEARCH_CLAUDE_API_KEY;
    delete process.env.WEB_SEARCH_CLAUDE_BASE_URL;
    delete process.env.WEB_SEARCH_CLAUDE_MODELS;
    delete process.env.SEARXNG_BASE_URL;
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

  it('allows official MiniMax client base URLs', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(
      resolveSafeClientWebSearchBaseUrl(
        'minimax',
        'https://api.minimaxi.com/v1/coding_plan/search',
      ),
    ).toBe('https://api.minimaxi.com/v1/coding_plan/search');
  });

  it('resolves classroom web search config from selected provider and client key', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'bocha',
        webSearchApiKey: 'bocha-client-key',
        webSearchBaseUrl: 'https://api.bochaai.com/v1',
      }),
    ).toEqual({
      providerId: 'bocha',
      apiKey: 'bocha-client-key',
      baseUrl: 'https://api.bochaai.com/v1',
    });
  });

  it('rejects unsupported client base URLs at the classroom server boundary', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(() =>
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'bocha',
        webSearchApiKey: 'bocha-client-key',
        webSearchBaseUrl: 'https://evil.example.com/steal-key',
      }),
    ).toThrow('Unsupported Bocha base URL');
  });

  it('uses server base URL for classroom web search config instead of client-controlled URLs', async () => {
    vi.stubEnv('BOCHA_API_KEY', 'bocha-server-key');
    vi.stubEnv('BOCHA_BASE_URL', 'http://internal-proxy.local/bocha');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'bocha',
        webSearchApiKey: 'stale-client-key',
        webSearchBaseUrl: 'https://api.bochaai.com/v1',
      }),
    ).toEqual({
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

  it('resolves MiniMax classroom web search config from dedicated server env vars', async () => {
    vi.stubEnv('WEB_SEARCH_MINIMAX_API_KEY', 'minimax-server-key');
    vi.stubEnv('WEB_SEARCH_MINIMAX_BASE_URL', 'https://api.minimaxi.com');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(resolveClassroomWebSearchConfig({ webSearchProviderId: 'minimax' })).toEqual({
      providerId: 'minimax',
      apiKey: 'minimax-server-key',
      baseUrl: 'https://api.minimaxi.com',
    });
  });

  it('allows official Claude client base URLs and rejects others', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(resolveSafeClientWebSearchBaseUrl('claude', 'https://api.anthropic.com/v1')).toBe(
      'https://api.anthropic.com/v1',
    );
    expect(resolveSafeClientWebSearchBaseUrl('claude', 'https://api.anthropic.com/')).toBe(
      'https://api.anthropic.com',
    );
    expect(() =>
      resolveSafeClientWebSearchBaseUrl('claude', 'https://evil.example.com/v1'),
    ).toThrow('Unsupported Claude base URL');
  });

  it('resolves Claude classroom web search config with the client-selected model', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'claude',
        webSearchApiKey: 'sk-client-key',
        webSearchModelId: 'claude-opus-5',
      }),
    ).toEqual({
      providerId: 'claude',
      apiKey: 'sk-client-key',
      baseUrl: undefined,
      claudeModelId: 'claude-opus-5',
    });
  });

  it('pins the Claude model from WEB_SEARCH_CLAUDE_MODELS over the client model', async () => {
    vi.stubEnv('WEB_SEARCH_CLAUDE_API_KEY', 'sk-server-key');
    vi.stubEnv('WEB_SEARCH_CLAUDE_BASE_URL', 'https://api.anthropic.com/v1');
    vi.stubEnv('WEB_SEARCH_CLAUDE_MODELS', 'claude-sonnet-5,claude-opus-5');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      resolveClassroomWebSearchConfig({
        webSearchProviderId: 'claude',
        webSearchModelId: 'claude-haiku-4-5',
      }),
    ).toEqual({
      providerId: 'claude',
      apiKey: 'sk-server-key',
      baseUrl: 'https://api.anthropic.com/v1',
      claudeModelId: 'claude-sonnet-5',
    });
  });

  it.each([
    'http://127.0.0.1:6060',
    'http://localhost:6060',
    'http://169.254.169.254',
    'http://192.168.161.100:6060/search',
  ])('rejects client-supplied SearXNG base URLs (%s)', async (baseUrl) => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');

    expect(() => resolveSafeClientWebSearchBaseUrl('searxng', baseUrl)).toThrow(
      'Unsupported SearXNG base URL',
    );
  });

  it('resolves SearXNG classroom web search config from server base URL', async () => {
    vi.stubEnv('SEARXNG_BASE_URL', 'http://192.168.161.100:6060');

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(resolveClassroomWebSearchConfig({ webSearchProviderId: 'searxng' })).toEqual({
      providerId: 'searxng',
      apiKey: '',
      baseUrl: 'http://192.168.161.100:6060',
    });
  });

  it('returns undefined for SearXNG classroom config without a base URL', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(resolveClassroomWebSearchConfig({ webSearchProviderId: 'searxng' })).toBeUndefined();
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
