import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock fs — only intercept server-providers.yml; delegate everything else to real fs.
// This prevents YAML config from leaking host-machine state into tests while keeping
// the mock scoped to what provider-config actually reads.
let yamlOverride: string | null = null;

const ENV_PREFIXES_TO_CLEAR = [
  'OPENAI',
  'AZURE_OPENAI',
  'ANTHROPIC',
  'GOOGLE',
  'DEEPSEEK',
  'QWEN',
  'KIMI',
  'MINIMAX',
  'GLM',
  'SILICONFLOW',
  'DOUBAO',
  'OPENROUTER',
  'GROK',
  'TENCENT',
  'TENCENT_HUNYUAN',
  'XIAOMI',
  'MIMO',
  'HY3',
  'OLLAMA',
  'TTS_OPENAI',
  'TTS_AZURE',
  'TTS_GLM',
  'TTS_QWEN',
  'TTS_DOUBAO',
  'TTS_ELEVENLABS',
  'TTS_MINIMAX',
  'ASR_OPENAI',
  'ASR_QWEN',
  'PDF_UNPDF',
  'PDF_MINERU',
  'PDF_MINERU_CLOUD',
  'IMAGE_OPENAI',
  'IMAGE_SEEDREAM',
  'IMAGE_QWEN_IMAGE',
  'IMAGE_NANO_BANANA',
  'IMAGE_MINIMAX',
  'IMAGE_GROK',
  'VIDEO_SEEDANCE',
  'VIDEO_KLING',
  'VIDEO_VEO',
  'VIDEO_SORA',
  'VIDEO_MINIMAX',
  'VIDEO_GROK',
  'BOCHA',
  'WEB_SEARCH_MINIMAX',
];

function clearProviderEnv() {
  for (const prefix of ENV_PREFIXES_TO_CLEAR) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
  }
  delete process.env.TAVILY_API_KEY;
  delete process.env.BOCHA_API_KEY;
  delete process.env.BOCHA_BASE_URL;
  delete process.env.ALIDOCMIND_ACCESS_KEY_ID;
  delete process.env.ALIDOCMIND_ACCESS_KEY_SECRET;
  delete process.env.ALIDOCMIND_BASE_URL;
}

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
      readFileSync: (p: string, ...args: unknown[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
    },
    existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
    readFileSync: (p: string, ...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
  };
});

describe('provider-config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearProviderEnv();
    yamlOverride = null;
  });

  describe('resolveApiKey', () => {
    it('returns client key when provided', async () => {
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('openai', 'sk-client')).toBe('sk-client');
    });

    it('returns server key from env when no client key', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-server');
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('openai')).toBe('sk-server');
    });

    it('returns empty string when neither client nor server key exists', async () => {
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('openai')).toBe('');
    });

    it('ignores client key for a server-managed provider (server is authoritative)', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-server');
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      // openai is server-configured ⇒ managed ⇒ client override is ignored.
      expect(resolveApiKey('openai', 'sk-client')).toBe('sk-server');
    });

    it('uses the client key for an unmanaged provider', async () => {
      // No env key for openai ⇒ not managed ⇒ client key flows through.
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('openai', 'sk-client')).toBe('sk-client');
    });

    it('resolves non-OpenAI providers via their env prefix', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic');
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('anthropic')).toBe('sk-anthropic');
    });

    it('resolves Azure OpenAI via its dedicated env prefix', async () => {
      vi.stubEnv('AZURE_OPENAI_API_KEY', 'azure-key');
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('azure')).toBe('azure-key');
    });

    it('returns empty string for unknown provider with no env var', async () => {
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('nonexistent-provider')).toBe('');
    });
  });

  describe('getParallelSceneConcurrency', () => {
    beforeEach(() => {
      delete process.env.PARALLEL_SCENE_CONCURRENCY;
    });

    it('defaults to 0 (serial) when unset', async () => {
      const { getParallelSceneConcurrency } = await import('@/lib/server/provider-config');
      expect(getParallelSceneConcurrency()).toBe(0);
    });

    it('reads a positive integer from the env var', async () => {
      vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', '3');
      const { getParallelSceneConcurrency } = await import('@/lib/server/provider-config');
      expect(getParallelSceneConcurrency()).toBe(3);
    });

    it('clamps to a maximum of 10', async () => {
      vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', '50');
      const { getParallelSceneConcurrency } = await import('@/lib/server/provider-config');
      expect(getParallelSceneConcurrency()).toBe(10);
    });

    it('treats zero, negative, and non-numeric values as off', async () => {
      for (const value of ['0', '-2', 'abc']) {
        vi.resetModules();
        vi.stubEnv('PARALLEL_SCENE_CONCURRENCY', value);
        const { getParallelSceneConcurrency } = await import('@/lib/server/provider-config');
        expect(getParallelSceneConcurrency(), `value=${value}`).toBe(0);
      }
    });
  });

  describe('resolveBaseUrl', () => {
    it('returns client URL for an unmanaged provider', async () => {
      const { resolveBaseUrl } = await import('@/lib/server/provider-config');
      expect(resolveBaseUrl('openai', 'https://custom.api.com')).toBe('https://custom.api.com');
    });

    it('ignores client URL for a server-managed provider', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-server');
      vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example.com/v1');
      const { resolveBaseUrl } = await import('@/lib/server/provider-config');
      // Managed ⇒ server URL wins, client override is dropped.
      expect(resolveBaseUrl('openai', 'https://client.example.com')).toBe(
        'https://proxy.example.com/v1',
      );
    });

    it('returns server URL from env when no client URL', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');
      vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example.com/v1');
      const { resolveBaseUrl } = await import('@/lib/server/provider-config');
      expect(resolveBaseUrl('openai')).toBe('https://proxy.example.com/v1');
    });

    it('returns undefined when neither client nor server URL exists', async () => {
      const { resolveBaseUrl } = await import('@/lib/server/provider-config');
      expect(resolveBaseUrl('openai')).toBeUndefined();
    });
  });

  describe('resolveProxy', () => {
    it('returns undefined when no proxy configured', async () => {
      const { resolveProxy } = await import('@/lib/server/provider-config');
      expect(resolveProxy('openai')).toBeUndefined();
    });

    it('returns proxy URL from YAML config', async () => {
      yamlOverride = `
providers:
  openai:
    apiKey: sk-yaml
    proxy: http://proxy.internal:8080
`;
      const { resolveProxy } = await import('@/lib/server/provider-config');
      expect(resolveProxy('openai')).toBe('http://proxy.internal:8080');
    });
  });

  describe('getServerProviders', () => {
    it('returns empty object when no providers configured', async () => {
      const { getServerProviders } = await import('@/lib/server/provider-config');
      expect(getServerProviders()).toEqual({});
    });

    it('returns allowed models but never the API key or base URL', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-secret');
      vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.com/v1');
      vi.stubEnv('OPENAI_MODELS', 'gpt-4o,gpt-4o-mini');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers.openai).toBeDefined();
      expect(providers.openai.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
      // Neither the API key nor the base URL may leak to the client.
      expect((providers.openai as Record<string, unknown>).apiKey).toBeUndefined();
      expect((providers.openai as Record<string, unknown>).baseUrl).toBeUndefined();
    });

    it('lists multiple providers', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(Object.keys(providers)).toContain('openai');
      expect(Object.keys(providers)).toContain('anthropic');
    });

    it('maps OpenRouter env prefix to provider ID', async () => {
      vi.stubEnv('OPENROUTER_API_KEY', 'sk-openrouter');
      vi.stubEnv('OPENROUTER_MODELS', 'deepseek/deepseek-v4-pro,deepseek/deepseek-v4-flash');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers.openrouter.models).toEqual([
        'deepseek/deepseek-v4-pro',
        'deepseek/deepseek-v4-flash',
      ]);
    });

    it('maps Azure deployment names to the built-in provider', async () => {
      vi.stubEnv('AZURE_OPENAI_API_KEY', 'azure-key');
      vi.stubEnv('AZURE_OPENAI_BASE_URL', 'https://test-resource.openai.azure.com/openai');
      vi.stubEnv('AZURE_OPENAI_MODELS', 'course-gpt-4o,course-gpt-5');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers.azure.models).toEqual(['course-gpt-4o', 'course-gpt-5']);
    });

    it('maps Tencent Hunyuan and Xiaomi MiMo env prefixes to provider IDs', async () => {
      vi.stubEnv('TENCENT_HUNYUAN_API_KEY', 'sk-tencent');
      vi.stubEnv('TENCENT_HUNYUAN_MODELS', 'hy3-preview,hunyuan-2.0-instruct-20251111');
      vi.stubEnv('MIMO_API_KEY', 'sk-mimo');
      vi.stubEnv('MIMO_MODELS', 'mimo-v2.5-pro');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers['tencent-hunyuan'].models).toEqual([
        'hy3-preview',
        'hunyuan-2.0-instruct-20251111',
      ]);
      expect(providers.xiaomi.models).toEqual(['mimo-v2.5-pro']);
    });

    it('does not treat HY3 as an env prefix', async () => {
      vi.stubEnv('HY3_API_KEY', 'sk-hy3');
      vi.stubEnv('HY3_MODELS', 'hy3-preview');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers['tencent-hunyuan']).toBeUndefined();
    });

    it('omits providers without API key', async () => {
      vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.com/v1');
      // No OPENAI_API_KEY set
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers.openai).toBeUndefined();
    });
  });

  describe('env var model parsing', () => {
    it('splits comma-separated models and trims whitespace', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');
      vi.stubEnv('OPENAI_MODELS', ' gpt-4o , gpt-4o-mini , ');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers.openai.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    });
  });

  describe('resolveWebSearchApiKey', () => {
    it('returns client key first', async () => {
      const { resolveWebSearchApiKey } = await import('@/lib/server/provider-config');
      expect(resolveWebSearchApiKey('client-key')).toBe('client-key');
    });

    it('falls back to TAVILY_API_KEY env var', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tvly-bare-env');
      const { resolveWebSearchApiKey } = await import('@/lib/server/provider-config');
      expect(resolveWebSearchApiKey()).toBe('tvly-bare-env');
    });

    it('resolves Bocha API key and base URL from env vars (managed flag only, no URL exposed)', async () => {
      vi.stubEnv('BOCHA_API_KEY', 'bocha-env-key');
      vi.stubEnv('BOCHA_BASE_URL', 'https://proxy.example.com/bocha');
      const { getServerWebSearchProviders, resolveWebSearchApiKey, resolveWebSearchBaseUrl } =
        await import('@/lib/server/provider-config');

      expect(resolveWebSearchApiKey('bocha', undefined)).toBe('bocha-env-key');
      expect(resolveWebSearchBaseUrl('bocha')).toBe('https://proxy.example.com/bocha');
      // The map exposes only the managed flag (presence) — not the base URL.
      expect(getServerWebSearchProviders().bocha).toEqual({});
    });

    it('ignores client key and base URL for a server-managed Bocha provider', async () => {
      vi.stubEnv('BOCHA_API_KEY', 'bocha-env-key');
      vi.stubEnv('BOCHA_BASE_URL', 'https://proxy.example.com/bocha');
      const { resolveWebSearchApiKey, resolveWebSearchBaseUrl } =
        await import('@/lib/server/provider-config');

      // Managed ⇒ server config is authoritative, client overrides dropped.
      expect(resolveWebSearchApiKey('bocha', 'bocha-client-key')).toBe('bocha-env-key');
      expect(resolveWebSearchBaseUrl('bocha', 'https://client.example.com')).toBe(
        'https://proxy.example.com/bocha',
      );
    });

    it('resolves MiniMax web search API key and base URL from dedicated env vars', async () => {
      vi.stubEnv('WEB_SEARCH_MINIMAX_API_KEY', 'minimax-env-key');
      vi.stubEnv('WEB_SEARCH_MINIMAX_BASE_URL', 'https://proxy.example.com/minimax');
      const { getServerWebSearchProviders, resolveWebSearchApiKey, resolveWebSearchBaseUrl } =
        await import('@/lib/server/provider-config');

      expect(resolveWebSearchApiKey('minimax', undefined)).toBe('minimax-env-key');
      expect(resolveWebSearchBaseUrl('minimax')).toBe('https://proxy.example.com/minimax');
      expect(getServerWebSearchProviders().minimax).toEqual({});
    });
  });

  describe('baseUrl-only providers (e.g. mineru)', () => {
    it('includes PDF provider from YAML when only baseUrl is configured (no apiKey)', async () => {
      yamlOverride = `
pdf:
  mineru:
    baseUrl: http://localhost:8888
`;
      const { getServerPDFProviders, resolvePDFBaseUrl } =
        await import('@/lib/server/provider-config');
      const providers = getServerPDFProviders();

      expect(providers.mineru).toBeDefined();
      expect(resolvePDFBaseUrl('mineru')).toBe('http://localhost:8888');
    });

    it('includes provider from env when only BASE_URL is set (no API_KEY)', async () => {
      vi.stubEnv('PDF_MINERU_BASE_URL', 'http://localhost:8888');
      const { getServerPDFProviders, resolvePDFBaseUrl } =
        await import('@/lib/server/provider-config');
      const providers = getServerPDFProviders();

      expect(providers.mineru).toBeDefined();
      expect(resolvePDFBaseUrl('mineru')).toBe('http://localhost:8888');
    });

    it('excludes PDF provider when only apiKey is configured (no baseUrl)', async () => {
      yamlOverride = `
pdf:
  mineru:
    apiKey: sk-fake
`;
      const { getServerPDFProviders } = await import('@/lib/server/provider-config');
      const providers = getServerPDFProviders();

      expect(providers.mineru).toBeUndefined();
    });

    it('includes MinerU Cloud from env when only API key is configured', async () => {
      vi.stubEnv('PDF_MINERU_CLOUD_API_KEY', 'mineru-cloud-key');
      const { getServerPDFProviders, resolvePDFApiKey, resolvePDFBaseUrl } =
        await import('@/lib/server/provider-config');
      const providers = getServerPDFProviders();

      expect(providers['mineru-cloud']).toBeDefined();
      expect(resolvePDFApiKey('mineru-cloud')).toBe('mineru-cloud-key');
      expect(resolvePDFBaseUrl('mineru-cloud')).toBeUndefined();
    });

    it('includes MinerU Cloud from YAML when only API key is configured', async () => {
      yamlOverride = `
pdf:
  mineru-cloud:
    apiKey: mineru-cloud-yaml-key
`;
      const { getServerPDFProviders, resolvePDFApiKey, resolvePDFBaseUrl } =
        await import('@/lib/server/provider-config');
      const providers = getServerPDFProviders();

      expect(providers['mineru-cloud']).toBeDefined();
      expect(resolvePDFApiKey('mineru-cloud')).toBe('mineru-cloud-yaml-key');
      expect(resolvePDFBaseUrl('mineru-cloud')).toBeUndefined();
    });
  });

  describe('image and video provider metadata', () => {
    it('uses standard OpenAI env vars for OpenAI image generation fallback', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
      vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example.com/v1');
      const { getServerImageProviders, resolveImageApiKey, resolveImageBaseUrl } =
        await import('@/lib/server/provider-config');

      const providers = getServerImageProviders();
      // No base URL exposed; resolution still works server-side.
      expect(providers['openai-image']).toEqual({});
      expect(resolveImageApiKey('openai-image')).toBe('sk-openai');
      expect(resolveImageBaseUrl('openai-image')).toBe('https://proxy.example.com/v1');
    });

    it('maps IMAGE_OPENAI and exposes image baseUrl', async () => {
      vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-openai-image');
      vi.stubEnv('IMAGE_OPENAI_BASE_URL', 'https://proxy.example.com/v1');
      const { getServerImageProviders, resolveImageBaseUrl } =
        await import('@/lib/server/provider-config');

      const providers = getServerImageProviders();
      expect(providers['openai-image']).toEqual({});
      expect(resolveImageBaseUrl('openai-image')).toBe('https://proxy.example.com/v1');
    });

    it('exposes video provider baseUrl', async () => {
      vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-secret');
      vi.stubEnv('VIDEO_GROK_BASE_URL', 'https://proxy.example.com/video');
      const { getServerVideoProviders, resolveVideoBaseUrl } =
        await import('@/lib/server/provider-config');

      const providers = getServerVideoProviders();
      expect(providers['grok-video']).toEqual({});
      expect(resolveVideoBaseUrl('grok-video')).toBe('https://proxy.example.com/video');
    });
  });

  describe('isServerConfiguredProvider', () => {
    it('is true only for operator-configured providers, per section', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
      vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-secret');
      const { isServerConfiguredProvider } = await import('@/lib/server/provider-config');

      expect(isServerConfiguredProvider('providers', 'openai')).toBe(true);
      expect(isServerConfiguredProvider('providers', 'anthropic')).toBe(false);
      expect(isServerConfiguredProvider('video', 'grok-video')).toBe(true);
      // section-scoped: an LLM provider id is not a video provider
      expect(isServerConfiguredProvider('video', 'openai')).toBe(false);
    });
  });

  describe('getServerTTSProviders force-disable (#665)', () => {
    it('reports nothing when no TTS provider is configured or disabled', async () => {
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      expect(getServerTTSProviders()).toEqual({});
    });

    it('marks an env-configured TTS provider as managed (no disabled flag)', async () => {
      vi.stubEnv('TTS_OPENAI_API_KEY', 'sk-tts');
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      expect(getServerTTSProviders()['openai-tts']).toEqual({});
    });

    it('force-disables a provider via TTS_<P>_ENABLED=false even when it has a key', async () => {
      vi.stubEnv('TTS_OPENAI_API_KEY', 'sk-tts');
      vi.stubEnv('TTS_OPENAI_ENABLED', 'false');
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      expect(getServerTTSProviders()['openai-tts']).toEqual({ disabled: true });
    });

    it('force-disables browser-native via env (it is client-only, has no key)', async () => {
      vi.stubEnv('TTS_BROWSER_NATIVE_ENABLED', 'false');
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      expect(getServerTTSProviders()['browser-native-tts']).toEqual({ disabled: true });
    });

    it('force-disables a provider via YAML tts.<id>.enabled: false', async () => {
      yamlOverride = 'tts:\n  voxcpm-tts:\n    enabled: false\n';
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      expect(getServerTTSProviders()['voxcpm-tts']).toEqual({ disabled: true });
    });

    it('env ENABLED=true overrides a YAML disable', async () => {
      yamlOverride = 'tts:\n  openai-tts:\n    enabled: false\n    apiKey: sk-yaml\n';
      vi.stubEnv('TTS_OPENAI_ENABLED', 'true');
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      // Re-enabled by env, and configured via YAML key ⇒ managed, not disabled.
      expect(getServerTTSProviders()['openai-tts']).toEqual({});
    });

    it('an empty TTS_<P>_ENABLED does NOT override a YAML disable', async () => {
      yamlOverride = 'tts:\n  openai-tts:\n    enabled: false\n    apiKey: sk-yaml\n';
      vi.stubEnv('TTS_OPENAI_ENABLED', '');
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      expect(getServerTTSProviders()['openai-tts']).toEqual({ disabled: true });
    });

    it('isServerTTSProviderDisabled reflects the force-disable set', async () => {
      vi.stubEnv('TTS_OPENAI_API_KEY', 'sk-tts');
      vi.stubEnv('TTS_OPENAI_ENABLED', 'false');
      const { isServerTTSProviderDisabled } = await import('@/lib/server/provider-config');
      expect(isServerTTSProviderDisabled('openai-tts')).toBe(true);
      expect(isServerTTSProviderDisabled('qwen-tts')).toBe(false);
    });
  });

  describe('resolveManagedAliDocMindCredentials (AK/SK)', () => {
    it('resolves YAML-managed AK/SK with NO ALIDOCMIND_* env vars', async () => {
      // Regression: verification resolved YAML creds but extraction only had an
      // env fallback, so a YAML-only deployment verified then failed to extract.
      yamlOverride =
        'pdf:\n  alidocmind:\n    accessKeyId: yaml-ak\n    accessKeySecret: yaml-sk\n';
      const { resolveManagedAliDocMindCredentials, isServerConfiguredProvider } =
        await import('@/lib/server/provider-config');
      expect(isServerConfiguredProvider('pdf', 'alidocmind')).toBe(true);
      expect(resolveManagedAliDocMindCredentials()).toEqual({
        accessKeyId: 'yaml-ak',
        accessKeySecret: 'yaml-sk',
        baseUrl: undefined,
      });
    });

    it('resolves YAML AK/SK even when the entry also has baseUrl', async () => {
      // Regression: a YAML entry WITH baseUrl makes the generic loader create a
      // pdf.alidocmind entry (copying only apiKey/baseUrl/models/proxy, never
      // AK/SK). The fallback must merge AK/SK into that entry, not skip it.
      yamlOverride =
        'pdf:\n  alidocmind:\n' +
        '    accessKeyId: review-ak\n' +
        '    accessKeySecret: review-sk\n' +
        '    baseUrl: https://docmind-api.cn-hangzhou.aliyuncs.com\n';
      const { resolveManagedAliDocMindCredentials, isServerConfiguredProvider } =
        await import('@/lib/server/provider-config');
      expect(isServerConfiguredProvider('pdf', 'alidocmind')).toBe(true);
      expect(resolveManagedAliDocMindCredentials()).toEqual({
        accessKeyId: 'review-ak',
        accessKeySecret: 'review-sk',
        baseUrl: 'https://docmind-api.cn-hangzhou.aliyuncs.com',
      });
    });

    it('resolves AK/SK from env vars', async () => {
      vi.stubEnv('ALIDOCMIND_ACCESS_KEY_ID', 'env-ak');
      vi.stubEnv('ALIDOCMIND_ACCESS_KEY_SECRET', 'env-sk');
      const { resolveManagedAliDocMindCredentials } = await import('@/lib/server/provider-config');
      expect(resolveManagedAliDocMindCredentials()).toMatchObject({
        accessKeyId: 'env-ak',
        accessKeySecret: 'env-sk',
      });
    });

    it('returns undefined when neither env nor YAML configures AliDocMind', async () => {
      const { resolveManagedAliDocMindCredentials, isServerConfiguredProvider } =
        await import('@/lib/server/provider-config');
      expect(resolveManagedAliDocMindCredentials()).toBeUndefined();
      expect(isServerConfiguredProvider('pdf', 'alidocmind')).toBe(false);
    });

    it('stays UNMANAGED when YAML sets baseUrl but no AK/SK (no lockout)', async () => {
      // Regression: a baseUrl-only YAML entry made the generic loader create a
      // pdf.alidocmind entry → isServerConfigured=true (managed) → but with no
      // AK/SK the provider was locked out AND client-entered creds were dropped.
      // With no usable server creds it must stay unmanaged so clients can supply
      // their own.
      yamlOverride =
        'pdf:\n  alidocmind:\n    baseUrl: https://docmind-api.cn-beijing.aliyuncs.com\n';
      const { resolveManagedAliDocMindCredentials, isServerConfiguredProvider } =
        await import('@/lib/server/provider-config');
      expect(isServerConfiguredProvider('pdf', 'alidocmind')).toBe(false);
      expect(resolveManagedAliDocMindCredentials()).toBeUndefined();
    });
  });
});
