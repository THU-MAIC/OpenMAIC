import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

async function deployment(config: ModelConfigFile | null) {
  const { setDeploymentConfigForTests } = await import('@/lib/server/model-config/runtime');
  if (!config) {
    setDeploymentConfigForTests();
    return;
  }
  setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy: false,
    notices: [],
  });
}

describe('server web search config', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    delete process.env.EXA_API_KEY;
    delete process.env.EXA_BASE_URL;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.FIRECRAWL_BASE_URL;
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
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    delete process.env.WEB_SEARCH_KIMI_ENABLED;
    await deployment(null);
  });

  afterEach(() => deployment(null));

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

  it('allows the web-search base URL every built-in token plan writes to client settings', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');
    const { TOKEN_PLAN_PRESETS } = await import('@/lib/config/token-plan-presets');
    const targets = TOKEN_PLAN_PRESETS.flatMap((preset) =>
      preset.modalities.webSearch ? [preset.modalities.webSearch] : [],
    );

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(
        resolveSafeClientWebSearchBaseUrl(
          target.providerId as Parameters<typeof resolveSafeClientWebSearchBaseUrl>[0],
          target.baseUrl,
        ),
      ).toBe(target.baseUrl.replace(/\/+$/, ''));
    }
    expect(() =>
      resolveSafeClientWebSearchBaseUrl('bocha', 'https://tokendance.space/gateway/other'),
    ).toThrow('Unsupported Bocha base URL');
  });

  it('allows official Exa client base URLs and resolves client credentials', async () => {
    const { resolveClassroomWebSearchConfig, resolveSafeClientWebSearchBaseUrl } =
      await import('@/lib/server/web-search-config');

    expect(resolveSafeClientWebSearchBaseUrl('exa', 'https://api.exa.ai/search')).toBe(
      'https://api.exa.ai/search',
    );
    expect(
      await resolveClassroomWebSearchConfig(null, {
        webSearchProviderId: 'exa',
        webSearchApiKey: 'exa-client-key',
        webSearchBaseUrl: 'https://api.exa.ai',
      }),
    ).toEqual({
      providerId: 'exa',
      apiKey: 'exa-client-key',
      baseUrl: 'https://api.exa.ai',
    });
  });

  it.each([
    ['exa', 'exa', 'https://proxy.example.com/exa', 'exa-server-key'],
    ['firecrawl', 'firecrawl', 'https://firecrawl.example.com', 'fc-server-key'],
    ['minimax-search', 'minimax', 'https://api.minimaxi.com', 'minimax-server-key'],
    ['searxng', 'searxng', 'http://search.example.com:6060', undefined],
  ])(
    'resolves the %s backend from the webSearch slot',
    async (preset, providerId, baseUrl, apiKey) => {
      await deployment({
        providers: { search: { preset, baseUrl, apiKey } },
        slots: { webSearch: 'search' },
      });
      const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');
      expect(await resolveClassroomWebSearchConfig(null)).toMatchObject({
        providerId,
        baseUrl,
        apiKey: apiKey ?? '',
      });
    },
  );

  it('allows official Firecrawl client base URLs and resolves client credentials', async () => {
    const { resolveClassroomWebSearchConfig, resolveSafeClientWebSearchBaseUrl } =
      await import('@/lib/server/web-search-config');

    expect(
      resolveSafeClientWebSearchBaseUrl('firecrawl', 'https://api.firecrawl.dev/v2/search'),
    ).toBe('https://api.firecrawl.dev/v2/search');
    expect(() => resolveSafeClientWebSearchBaseUrl('firecrawl', 'http://127.0.0.1:3002')).toThrow(
      'Unsupported Firecrawl base URL',
    );
    expect(
      await resolveClassroomWebSearchConfig(null, {
        webSearchProviderId: 'firecrawl',
        webSearchApiKey: 'fc-client-key',
        webSearchBaseUrl: 'https://api.firecrawl.dev',
      }),
    ).toEqual({
      providerId: 'firecrawl',
      apiKey: 'fc-client-key',
      baseUrl: 'https://api.firecrawl.dev',
    });
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
      await resolveClassroomWebSearchConfig(null, {
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

  it('keeps the request body usable until the webSearch slot is assigned', async () => {
    const { resolveClassroomWebSearchConfig, resolveWebSearchConnection } =
      await import('@/lib/server/web-search-config');
    const requested = { webSearchProviderId: 'exa' as const, webSearchApiKey: 'exa-client-key' };
    expect(await resolveClassroomWebSearchConfig(null, requested)).toMatchObject({
      providerId: 'exa',
      apiKey: 'exa-client-key',
    });
    await deployment({
      providers: { search: { preset: 'tavily', apiKey: 'server-tavily' } },
      slots: { webSearch: 'search' },
    });
    expect(await resolveClassroomWebSearchConfig(null, requested)).toMatchObject({
      providerId: 'tavily',
      apiKey: 'server-tavily',
    });
    expect(
      await resolveWebSearchConnection(null, requested, { preferServerProvider: true }),
    ).toMatchObject({ providerId: 'tavily', apiKey: 'server-tavily' });
  });

  it('rejects unsupported client base URLs at the classroom server boundary', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    await expect(
      resolveClassroomWebSearchConfig(null, {
        webSearchProviderId: 'bocha',
        webSearchApiKey: 'bocha-client-key',
        webSearchBaseUrl: 'https://evil.example.com/steal-key',
      }),
    ).rejects.toThrow('Unsupported Bocha base URL');
  });

  it('uses server base URL for classroom web search config instead of client-controlled URLs', async () => {
    await deployment({
      providers: {
        search: {
          preset: 'bocha',
          apiKey: 'bocha-server-key',
          baseUrl: 'http://bocha.example.com/v1',
        },
      },
      slots: { webSearch: 'search' },
    });

    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      await resolveClassroomWebSearchConfig(null, {
        webSearchProviderId: 'bocha',
        webSearchApiKey: 'stale-client-key',
        webSearchBaseUrl: 'https://api.bochaai.com/v1',
      }),
    ).toEqual({
      providerId: 'bocha',
      apiKey: 'bocha-server-key',
      baseUrl: 'http://bocha.example.com/v1',
    });
  });

  it('resolves Brave classroom web search config without an API key', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(await resolveClassroomWebSearchConfig(null, { webSearchProviderId: 'brave' })).toEqual({
      providerId: 'brave',
      apiKey: '',
      baseUrl: undefined,
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
      await resolveClassroomWebSearchConfig(null, {
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

  it('uses the configured Claude model even if an old request body names another model', async () => {
    await deployment({
      providers: {
        search: { preset: 'claude', apiKey: 'sk-server-key', models: ['claude-opus-5'] },
      },
      slots: { webSearch: 'search:claude-opus-5' },
    });
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');
    expect(
      await resolveClassroomWebSearchConfig(null, {
        webSearchProviderId: 'claude',
        webSearchModelId: 'claude-haiku-4-5',
      }),
    ).toMatchObject({ providerId: 'claude', claudeModelId: 'claude-opus-5' });
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

  it('returns undefined for SearXNG classroom config without a base URL', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      await resolveClassroomWebSearchConfig(null, { webSearchProviderId: 'searxng' }),
    ).toBeUndefined();
  });

  it('keeps Baidu sub-source toggles in classroom web search config', async () => {
    const { resolveClassroomWebSearchConfig } = await import('@/lib/server/web-search-config');

    expect(
      await resolveClassroomWebSearchConfig(null, {
        webSearchProviderId: 'baidu',
        webSearchApiKey: 'request-baidu-key',
        baiduSubSources: { webSearch: false, baike: true, scholar: false },
      }),
    ).toEqual({
      providerId: 'baidu',
      apiKey: 'request-baidu-key',
      baseUrl: undefined,
      baiduSubSources: { webSearch: false, baike: true, scholar: false },
    });
  });
});

describe('Kimi official search bases', () => {
  it.each([
    'https://api.moonshot.cn/v1',
    'https://api.moonshot.ai/v1',
    'https://api.kimi.com/coding/v1',
    'https://api.kimi.ai/coding/v1',
  ])('accepts %s', async (baseUrl) => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');
    expect(resolveSafeClientWebSearchBaseUrl('kimi', baseUrl)).toBe(baseUrl);
  });
  it('rejects lookalike endpoints', async () => {
    const { resolveSafeClientWebSearchBaseUrl } = await import('@/lib/server/web-search-config');
    expect(() =>
      resolveSafeClientWebSearchBaseUrl('kimi', 'https://api.kimi.com.openmaic.test/coding/v1'),
    ).toThrow('Unsupported Kimi base URL');
  });
});

describe('chat-only Kimi search requests', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('KIMI_API_KEY', 'operator-chat-key');
    vi.stubEnv('WEB_SEARCH_KIMI_ENABLED', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('SEARXNG_BASE_URL', '');
  });

  it('does not redirect a user Tavily request to the operator chat account', async () => {
    const { resolveWebSearchConnection, resolveClassroomWebSearchConfig } =
      await import('@/lib/server/web-search-config');
    expect(await resolveClassroomWebSearchConfig(null)).toBeUndefined();
    expect(
      await resolveWebSearchConnection(
        null,
        {
          webSearchProviderId: 'tavily',
          webSearchApiKey: 'user-search-key',
        },
        { preferServerProvider: true },
      ),
    ).toMatchObject({ providerId: 'tavily', apiKey: 'user-search-key' });
  });
});
