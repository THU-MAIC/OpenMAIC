import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock fs — only intercept server-providers.yml; delegate everything else to real fs.
// This prevents YAML config from leaking host-machine state into tests while keeping
// the mock scoped to what provider-config actually reads.
let yamlOverride: string | null = null;

const ENV_PREFIXES_TO_CLEAR = [
  'OPENAI',
  'AZURE_OPENAI',
  'ATLASCLOUD',
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
  'TOKENDANCE',
  'HY3',
  'OLLAMA',
  'BEDROCK',
  'TTS_OPENAI',
  'TTS_AZURE',
  'TTS_GLM',
  'TTS_QWEN',
  'TTS_DOUBAO',
  'TTS_ELEVENLABS',
  'TTS_GOOGLE',
  'TTS_MINIMAX',
  'TTS_VOXCPM',
  'ASR_OPENAI',
  'ASR_QWEN',
  'ASR_FUNASR',
  'PDF_UNPDF',
  'PDF_MINERU',
  'PDF_MINERU_CLOUD',
  'PDF_DEEPSEEK_OCR',
  'TTS_DEEPSEEK',
  'ASR_DEEPSEEK',
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
  'EXA',
  'FIRECRAWL',
  'BOCHA',
  'WEB_SEARCH_MINIMAX',
  'WEB_SEARCH_KIMI',
  'WEB_SEARCH_DEEPSEEK',
  'BRAVE',
  'SEARXNG',
  'WEB_SEARCH_CLAUDE',
  'WEB_SEARCH_DOUBAO',
];

function clearProviderEnv() {
  for (const prefix of ENV_PREFIXES_TO_CLEAR) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
    delete process.env[`${prefix}_ENABLED`];
  }
  delete process.env.TAVILY_API_KEY;
  delete process.env.BOCHA_API_KEY;
  delete process.env.BOCHA_BASE_URL;
  delete process.env.ALIDOCMIND_ACCESS_KEY_ID;
  delete process.env.ALIDOCMIND_ACCESS_KEY_SECRET;
  delete process.env.ALIDOCMIND_BASE_URL;
  delete process.env.BEDROCK_REGION;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  delete process.env.TTS_QWEN_VOICE_CLONE_MODEL;
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
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('openmaic.model-config.deployment')];
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

    it('returns empty string when neither client nor server key exists', async () => {
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('openai')).toBe('');
    });

    it('uses the client key for an unmanaged provider', async () => {
      // No env key for openai ⇒ not managed ⇒ client key flows through.
      const { resolveApiKey } = await import('@/lib/server/provider-config');
      expect(resolveApiKey('openai', 'sk-client')).toBe('sk-client');
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
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('openmaic.model-config.deployment')
        ];
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
  });

  describe('resolveWebSearchApiKey', () => {
    it('returns client key first', async () => {
      const { resolveWebSearchApiKey } = await import('@/lib/server/provider-config');
      expect(resolveWebSearchApiKey('client-key')).toBe('client-key');
    });

    it('lets the client model win when no Claude model is pinned server-side', async () => {
      const { resolveWebSearchModel } = await import('@/lib/server/provider-config');

      expect(resolveWebSearchModel('claude', 'claude-opus-5')).toBe('claude-opus-5');
      expect(resolveWebSearchModel('claude')).toBeUndefined();
    });
  });

  describe('media model resolution', () => {
    it('lets the client image model win when nothing is pinned server-side', async () => {
      const { resolveImageModel } = await import('@/lib/server/provider-config');
      expect(resolveImageModel('seedream', 'client-model')).toBe('client-model');
    });

    it('returns undefined for the image model when neither client nor server provides one', async () => {
      const { resolveImageModel } = await import('@/lib/server/provider-config');
      expect(resolveImageModel('seedream')).toBeUndefined();
    });

    it('returns undefined for the default image provider when none is configured', async () => {
      const { resolveServerImageProviderId } = await import('@/lib/server/provider-config');
      expect(resolveServerImageProviderId()).toBeUndefined();
    });

    it('lets the client video model win when nothing is pinned server-side', async () => {
      const { resolveVideoModel } = await import('@/lib/server/provider-config');
      expect(resolveVideoModel('seedance', 'client-model')).toBe('client-model');
    });

    it('returns undefined for the video model when neither client nor server provides one', async () => {
      const { resolveVideoModel } = await import('@/lib/server/provider-config');
      expect(resolveVideoModel('seedance')).toBeUndefined();
    });

    it('returns undefined for the default video provider when none is configured', async () => {
      const { resolveServerVideoProviderId } = await import('@/lib/server/provider-config');
      expect(resolveServerVideoProviderId()).toBeUndefined();
    });

    it('lets the client ASR model win when nothing is pinned server-side', async () => {
      const { resolveASRModel } = await import('@/lib/server/provider-config');
      expect(resolveASRModel('openai-whisper', 'client-model')).toBe('client-model');
    });

    it('returns undefined for the ASR model when neither client nor server provides one', async () => {
      const { resolveASRModel } = await import('@/lib/server/provider-config');
      expect(resolveASRModel('openai-whisper')).toBeUndefined();
    });
  });

  describe('isServerConfiguredProvider', () => {
    it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
      'does not treat the inherited property name %s as a configured provider',
      async (providerId) => {
        vi.stubEnv('OPENAI_API_KEY', 'sk-openai');
        const {
          isServerConfiguredProvider,
          resolveApiKey,
          resolveBaseUrl,
          resolveProxy,
          resolveTTSApiKey,
          resolveASRModel,
          resolveImageModel,
          resolveVideoModel,
          resolveWebSearchModel,
        } = await import('@/lib/server/provider-config');

        for (const section of ['providers', 'tts', 'asr', 'pdf', 'image', 'video'] as const) {
          expect(isServerConfiguredProvider(section, providerId)).toBe(false);
        }
        // Unmanaged: the client's values are used, not an inherited property.
        expect(resolveApiKey(providerId, 'client-key')).toBe('client-key');
        expect(resolveTTSApiKey(providerId, 'client-key')).toBe('client-key');
        expect(resolveBaseUrl(providerId, 'https://client.example/v1')).toBe(
          'https://client.example/v1',
        );
        expect(resolveProxy(providerId)).toBeUndefined();
        expect(resolveASRModel(providerId, 'm')).toBe('m');
        expect(resolveImageModel(providerId, 'm')).toBe('m');
        expect(resolveVideoModel(providerId, 'm')).toBe('m');
        expect(resolveWebSearchModel(providerId, 'm')).toBe('m');
      },
    );
  });

  describe('getServerTTSProviders force-disable (#665)', () => {
    it('reports nothing when no TTS provider is configured or disabled', async () => {
      const { getServerTTSProviders } = await import('@/lib/server/provider-config');
      expect(getServerTTSProviders()).toEqual({});
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
      // The env switch clears the YAML force-off policy.
      expect(getServerTTSProviders()['openai-tts']).toBeUndefined();
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

  describe('per-capability force-disable (#665)', () => {
    it('image: force-disables via IMAGE_<P>_ENABLED=false even when it has a key', async () => {
      vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-img');
      vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
      const { getServerImageProviders } = await import('@/lib/server/provider-config');
      expect(getServerImageProviders()['openai-image']).toEqual({ disabled: true });
    });

    it('image: force-disables the keyless client-only ComfyUI provider via env', async () => {
      vi.stubEnv('IMAGE_COMFYUI_ENABLED', 'false');
      const { getServerImageProviders } = await import('@/lib/server/provider-config');
      expect(getServerImageProviders()['comfyui-image']).toEqual({ disabled: true });
    });

    it('image: an _ENABLED=true value does NOT force-enable an unconfigured keyless provider', async () => {
      vi.stubEnv('IMAGE_COMFYUI_ENABLED', 'true');
      const { getServerImageProviders, resolveServerImageProviderId } =
        await import('@/lib/server/provider-config');
      // ComfyUI has no credential env, so a truthy _ENABLED must not conjure a
      // configured/enabled entry out of thin air — it can only disable (#665).
      expect(getServerImageProviders()['comfyui-image']).toBeUndefined();
      expect(resolveServerImageProviderId()).toBeUndefined();
    });

    it('image: force-disables via YAML image.<id>.enabled: false', async () => {
      yamlOverride = 'image:\n  seedream:\n    enabled: false\n';
      const { getServerImageProviders } = await import('@/lib/server/provider-config');
      expect(getServerImageProviders()['seedream']).toEqual({ disabled: true });
    });

    it('image: env ENABLED=true overrides a YAML disable', async () => {
      yamlOverride = 'image:\n  openai-image:\n    enabled: false\n    apiKey: sk-yaml\n';
      vi.stubEnv('IMAGE_OPENAI_ENABLED', 'true');
      const { getServerImageProviders } = await import('@/lib/server/provider-config');
      expect(getServerImageProviders()['openai-image']).toBeUndefined();
    });

    it('image: an empty IMAGE_<P>_ENABLED does NOT override a YAML disable', async () => {
      yamlOverride = 'image:\n  openai-image:\n    enabled: false\n    apiKey: sk-yaml\n';
      vi.stubEnv('IMAGE_OPENAI_ENABLED', '');
      const { getServerImageProviders } = await import('@/lib/server/provider-config');
      expect(getServerImageProviders()['openai-image']).toEqual({ disabled: true });
    });

    it('asr: force-disables a keyed provider via ASR_<P>_ENABLED=false even when it has a key', async () => {
      vi.stubEnv('ASR_OPENAI_API_KEY', 'sk-asr');
      vi.stubEnv('ASR_OPENAI_ENABLED', 'false');
      const { getServerASRProviders } = await import('@/lib/server/provider-config');
      expect(getServerASRProviders()['openai-whisper']).toEqual({ disabled: true });
    });

    it('asr: force-disables the client-only browser-native provider via env', async () => {
      vi.stubEnv('ASR_BROWSER_NATIVE_ENABLED', 'false');
      const { getServerASRProviders } = await import('@/lib/server/provider-config');
      expect(getServerASRProviders()['browser-native']).toEqual({ disabled: true });
    });

    it('video: force-disables via VIDEO_<P>_ENABLED=false even when it has a key', async () => {
      vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-video');
      vi.stubEnv('VIDEO_GROK_ENABLED', 'false');
      const { getServerVideoProviders } = await import('@/lib/server/provider-config');
      expect(getServerVideoProviders()['grok-video']).toEqual({ disabled: true });
    });

    it('video: force-disables via YAML video.<id>.enabled: false', async () => {
      yamlOverride = 'video:\n  kling:\n    enabled: false\n    apiKey: sk-yaml\n';
      const { getServerVideoProviders } = await import('@/lib/server/provider-config');
      expect(getServerVideoProviders()['kling']).toEqual({ disabled: true });
    });

    it('web-search: force-disables a keyed provider via <P>_ENABLED=false even when it has a key', async () => {
      vi.stubEnv('TAVILY_API_KEY', 'tvly-key');
      vi.stubEnv('TAVILY_ENABLED', 'false');
      const { getServerWebSearchProviders } = await import('@/lib/server/provider-config');
      expect(getServerWebSearchProviders()['tavily']).toEqual({ disabled: true });
    });

    it('web-search: force-disables Exa through EXA_ENABLED=false', async () => {
      vi.stubEnv('EXA_API_KEY', 'exa-key');
      vi.stubEnv('EXA_ENABLED', 'false');
      const { getServerWebSearchProviders } = await import('@/lib/server/provider-config');
      expect(getServerWebSearchProviders().exa).toEqual({ disabled: true });
    });

    it('web-search: force-disables Firecrawl through FIRECRAWL_ENABLED=false', async () => {
      vi.stubEnv('FIRECRAWL_API_KEY', 'fc-key');
      vi.stubEnv('FIRECRAWL_ENABLED', 'false');
      const { getServerWebSearchProviders } = await import('@/lib/server/provider-config');
      expect(getServerWebSearchProviders().firecrawl).toEqual({ disabled: true });
    });

    it('web-search: force-disables the keyless SearXNG provider via env', async () => {
      vi.stubEnv('SEARXNG_BASE_URL', 'http://searxng.internal');
      vi.stubEnv('SEARXNG_ENABLED', 'false');
      const { getServerWebSearchProviders } = await import('@/lib/server/provider-config');
      expect(getServerWebSearchProviders()['searxng']).toEqual({ disabled: true });
    });

    it('web-search: force-disables the built-in Doubao provider via its dedicated env', async () => {
      vi.stubEnv('WEB_SEARCH_DOUBAO_ENABLED', 'false');
      const { getServerWebSearchProviders } = await import('@/lib/server/provider-config');
      expect(getServerWebSearchProviders().doubao).toEqual({ disabled: true });
    });

    it('isServerProviderDisabled reflects the per-section force-disable set', async () => {
      vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-img');
      vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
      vi.stubEnv('VIDEO_GROK_ENABLED', 'false');
      vi.stubEnv('ASR_OPENAI_ENABLED', 'false');
      const { isServerProviderDisabled } = await import('@/lib/server/provider-config');
      expect(isServerProviderDisabled('image', 'openai-image')).toBe(true);
      expect(isServerProviderDisabled('image', 'seedream')).toBe(false);
      expect(isServerProviderDisabled('video', 'grok-video')).toBe(true);
      expect(isServerProviderDisabled('asr', 'openai-whisper')).toBe(true);
      expect(isServerProviderDisabled('tts', 'openai-tts')).toBe(false);
    });
  });

  describe('enabledProviderIds resolver (#665)', () => {
    it('returns only non-disabled entries of a capability listing', async () => {
      const { enabledProviderIds } = await import('@/lib/server/provider-config');
      expect(
        enabledProviderIds({
          'openai-image': { models: ['gpt-image-1'] },
          seedream: { disabled: true },
          'grok-image': {},
        }),
      ).toEqual(['openai-image', 'grok-image']);
    });

    it('keeps object-key order and drops nothing when nothing is disabled', async () => {
      const { enabledProviderIds } = await import('@/lib/server/provider-config');
      expect(enabledProviderIds({ a: {}, b: { models: [] }, c: { disabled: false } })).toEqual([
        'a',
        'b',
        'c',
      ]);
    });

    it('returns an empty list when every entry is force-disabled', async () => {
      const { enabledProviderIds } = await import('@/lib/server/provider-config');
      expect(enabledProviderIds({ a: { disabled: true }, b: { disabled: true } })).toEqual([]);
    });
  });

  describe('Qwen TTS resolution', () => {
    it.each([
      ['', 'cosyvoice-v3.5-plus'],
      ['  \t ', 'cosyvoice-v3.5-plus'],
      ['qwen3-tts-vc-2026-01-22', 'cosyvoice-v3.5-plus'],
      ['  qwen3-tts-vc-2026-01-22  ', 'cosyvoice-v3.5-plus'],
      [' custom-clone-model ', 'custom-clone-model'],
      [' cosyvoice-v3.5-flash ', 'cosyvoice-v3.5-flash'],
      [' qwen3-tts-vc-custom ', 'qwen3-tts-vc-custom'],
    ])('resolves the clone environment override %j to %s', async (value, expected) => {
      vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', value);
      const { resolveQwenVoiceCloneModel } = await import('@/lib/server/provider-config');
      expect(resolveQwenVoiceCloneModel()).toBe(expected);
    });

    it.each(['cosyvoice-v3.5-plus', 'cosyvoice-v3.5-flash'])(
      'authorizes the persisted grouping ID as its configured clone target %s',
      async (target) => {
        vi.stubEnv('TTS_QWEN_API_KEY', 'key');
        vi.stubEnv('TTS_QWEN_MODELS', `qwen3-tts-flash,${target}`);
        vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', target);
        const { resolveTTSModel } = await import('@/lib/server/provider-config');
        expect(resolveTTSModel('qwen-tts', ' qwen3-tts-vc-2026-01-22 ', `${target}-voice`)).toBe(
          target,
        );
      },
    );

    it('uses the provider default base URL when none is configured or supplied', async () => {
      const { resolveTTSBaseUrl } = await import('@/lib/server/provider-config');
      expect(resolveTTSBaseUrl('qwen-tts')).toBe('https://dashscope.aliyuncs.com/api/v1');
    });

    it('reads the VC override only from server-side resolution', async () => {
      vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', 'operator-vc-model');
      const { resolveQwenVoiceCloneModel } = await import('@/lib/server/provider-config');
      expect(resolveQwenVoiceCloneModel()).toBe('operator-vc-model');
    });
  });

  describe('resolveManagedAliDocMindCredentials (AK/SK)', () => {
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

it.each(['KIMI', 'DEEPSEEK'])('retains the %s search force-off switch', async (provider) => {
  vi.resetModules();
  vi.stubEnv(`WEB_SEARCH_${provider}_ENABLED`, 'false');
  try {
    const { isServerProviderDisabled } = await import('@/lib/server/provider-config');
    expect(isServerProviderDisabled('webSearch', provider.toLowerCase())).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('does not read retired YAML or env credentials into provider settings', async () => {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', 'env-provider-key');
  yamlOverride = 'providers:\n  openai:\n    apiKey: yaml-provider-key\n';
  try {
    const { resolveApiKey, isServerConfiguredProvider } =
      await import('@/lib/server/provider-config');
    expect(resolveApiKey('openai')).toBe('');
    expect(resolveApiKey('openai', 'body-key')).toBe('body-key');
    expect(isServerConfiguredProvider('providers', 'openai')).toBe(false);
  } finally {
    vi.unstubAllEnvs();
    yamlOverride = null;
  }
});
