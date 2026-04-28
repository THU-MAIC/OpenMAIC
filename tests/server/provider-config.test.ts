import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock fs — only intercept server-providers.yml; delegate everything else to real fs.
// This prevents YAML config from leaking host-machine state into tests while keeping
// the mock scoped to what provider-config actually reads.
let yamlOverride: string | null = null;

const ENV_PREFIXES_TO_CLEAR = [
  'OPENAI',
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
];

function clearProviderEnv() {
  for (const prefix of ENV_PREFIXES_TO_CLEAR) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
  }
  delete process.env.TAVILY_API_KEY;
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

    it('prefers client key over server key', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-server');
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('openai', 'sk-client')).toBe('sk-client');
    });

    it('resolves non-OpenAI providers via their env prefix', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-anthropic');
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('anthropic')).toBe('sk-anthropic');
    });

    it('returns empty string for unknown provider with no env var', async () => {
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('nonexistent-provider')).toBe('');
    });
  });

  describe('resolveBaseUrl', () => {
    it('returns client URL when provided', async () => {
      const { resolveBaseUrl } = await import('@/lib/server/provider-config');
      expect(resolveBaseUrl('openai', 'https://custom.api.com')).toBe('https://custom.api.com');
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

    it('returns provider metadata without API keys', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-secret');
      vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.com/v1');
      vi.stubEnv('OPENAI_MODELS', 'gpt-4o,gpt-4o-mini');
      const { getServerProviders } = await import('@/lib/server/provider-config');
      const providers = getServerProviders();

      expect(providers.openai).toBeDefined();
      expect(providers.openai.models).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(providers.openai.baseUrl).toBe('https://proxy.com/v1');
      // API key must NOT be exposed
      expect((providers.openai as Record<string, unknown>).apiKey).toBeUndefined();
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
  });

  describe('baseUrl-only providers (e.g. mineru)', () => {
    it('includes PDF provider from YAML when only baseUrl is configured (no apiKey)', async () => {
      yamlOverride = `
pdf:
  mineru:
    baseUrl: http://localhost:8888
`;
      const { getServerPDFProviders } = await import('@/lib/server/provider-config');
      const providers = getServerPDFProviders();

      expect(providers.mineru).toBeDefined();
      expect(providers.mineru.baseUrl).toBe('http://localhost:8888');
    });

    it('includes provider from env when only BASE_URL is set (no API_KEY)', async () => {
      vi.stubEnv('PDF_MINERU_BASE_URL', 'http://localhost:8888');
      const { getServerPDFProviders } = await import('@/lib/server/provider-config');
      const providers = getServerPDFProviders();

      expect(providers.mineru).toBeDefined();
      expect(providers.mineru.baseUrl).toBe('http://localhost:8888');
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
  });

  describe('image and video provider metadata', () => {
    it('maps IMAGE_OPENAI and exposes image baseUrl', async () => {
      vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-openai-image');
      vi.stubEnv('IMAGE_OPENAI_BASE_URL', 'https://proxy.example.com/v1');
      const { getServerImageProviders, resolveImageBaseUrl } =
        await import('@/lib/server/provider-config');

      const providers = getServerImageProviders();
      expect(providers['openai-image']).toEqual({ baseUrl: 'https://proxy.example.com/v1' });
      expect(resolveImageBaseUrl('openai-image')).toBe('https://proxy.example.com/v1');
    });

    it('exposes video provider baseUrl', async () => {
      vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-secret');
      vi.stubEnv('VIDEO_GROK_BASE_URL', 'https://proxy.example.com/video');
      const { getServerVideoProviders, resolveVideoBaseUrl } =
        await import('@/lib/server/provider-config');

      const providers = getServerVideoProviders();
      expect(providers['grok-video']).toEqual({ baseUrl: 'https://proxy.example.com/video' });
      expect(resolveVideoBaseUrl('grok-video')).toBe('https://proxy.example.com/video');
    });
  });
});
