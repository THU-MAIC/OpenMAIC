import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  yaml: '',
  warn: vi.fn(),
  getModel: vi.fn(() => ({ model: {}, modelInfo: undefined })),
}));
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) =>
        p.endsWith('server-providers.yml') ? !!mocks.yaml : actual.existsSync(p),
      readFileSync: (p: string, ...args: unknown[]) =>
        p.endsWith('server-providers.yml')
          ? mocks.yaml
          : (actual.readFileSync as (...args: unknown[]) => unknown)(p, ...args),
    },
  };
});
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/ai/providers', async (original) => ({
  ...(await original<typeof import('@/lib/ai/providers')>()),
  getModel: mocks.getModel,
}));
vi.mock('@/lib/server/ssrf-guard', async (original) => ({
  ...(await original<typeof import('@/lib/server/ssrf-guard')>()),
  validateClientBaseUrl: async () => null,
  validateUrlForSSRF: async () => null,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.yaml = '';
  for (const key of Object.keys(process.env))
    if (
      /(?:_API_KEY|_BASE_URL|_MODELS)$/.test(key) ||
      [
        'DEFAULT_MODEL',
        'MODEL_FALLBACK',
        'MODEL_ROUTES',
        'BEDROCK_REGION',
        'AWS_BEARER_TOKEN_BEDROCK',
        'TTS_QWEN_VOICE_CLONE_MODEL',
      ].includes(key)
    )
      vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());
const denied = {
  code: 'PROVIDER_DISABLED',
  httpStatus: 403,
  message: 'This model is not authorized for server-managed credentials',
};
describe('1.1.x authorized sets', () => {
  it('grants only explicit chat lists, deployment defaults/fallbacks and operator stage references', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server');
    vi.stubEnv('OPENAI_MODELS', ' listed , other ');
    vi.stubEnv('DEFAULT_MODEL', 'openai: default ');
    vi.stubEnv('MODEL_FALLBACK', 'openai: fallback ');
    vi.stubEnv('MODEL_ROUTES', JSON.stringify({ 'quiz-grade': 'openai: stage ' }));
    const { resolveModel } = await import('@/lib/server/resolve-model');
    for (const model of ['listed', 'other', 'default', 'fallback', 'stage']) {
      await resolveModel({ modelString: `openai:${model}` });
      expect(mocks.getModel).toHaveBeenLastCalledWith(
        expect.objectContaining({ modelId: model, apiKey: 'server' }),
      );
    }
    for (const model of ['gpt-4o-mini', 'unknown', 'LISTED', 'listed\u200b', 'openai/listed'])
      await expect(
        resolveModel({ modelString: `openai:${model}`, apiKey: 'user' }),
      ).rejects.toMatchObject(denied);
    expect(mocks.getModel).toHaveBeenCalledTimes(5);
  });
  it('normalizes surrounding model whitespace consistently before checking and sending', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server');
    vi.stubEnv('OPENAI_MODELS', 'allowed');
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({ modelString: 'openai: allowed\u00a0' });
    expect(mocks.getModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'allowed' }));
  });
  it('does not let request stage routes, empty keys or other providers expand the set', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server');
    vi.stubEnv('DEFAULT_MODEL', 'anthropic:secret');
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(
      resolveModel({
        stage: 'quiz-grade',
        userRoutes: { 'quiz-grade': { model: 'openai:secret', apiKey: '' } },
      }),
    ).rejects.toMatchObject(denied);
    expect(mocks.getModel).not.toHaveBeenCalled();
  });
  it('enforces Bedrock credential chains with no API key', async () => {
    vi.stubEnv('BEDROCK_REGION', 'us-east-1');
    vi.stubEnv('BEDROCK_MODELS', 'allowed');
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(resolveModel({ modelString: 'bedrock:unknown' })).rejects.toMatchObject(denied);
    await resolveModel({ modelString: 'bedrock:allowed' });
  });
  it.each(['ollama', 'lemonade'])('leaves keyless %s unrestricted', async (id) => {
    vi.stubEnv(`${id.toUpperCase()}_BASE_URL`, 'https://local.example/v1');
    vi.stubEnv(`${id.toUpperCase()}_MODELS`, 'listed');
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({ modelString: `${id}:anything` });
    expect(mocks.getModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'anything', apiKey: '' }),
    );
  });
  it('BYOK uses only the client key even with ambient credentials for a different id', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server');
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      modelString: 'my-provider:anything',
      apiKey: 'user',
      providerType: 'openai',
    });
    expect(mocks.getModel).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'anything', apiKey: 'user' }),
    );
  });
  it('normalizes YAML lists including Bedrock, and keeps capability grants separate', async () => {
    mocks.yaml =
      'providers:\n  bedrock:\n    models: [" allowed "]\nimage:\n  openai-image:\n    apiKey: server\n    models: [" image "]\ntts:\n  openai-tts:\n    apiKey: server\n    models: [" speech "]\n';
    const cfg = await import('@/lib/server/provider-config');
    cfg.authorizeServerModel('providers', 'bedrock', 'allowed');
    expect(cfg.resolveImageModel('openai-image', ' image ')).toBe('image');
    expect(() => cfg.resolveImageModel('openai-image', 'speech')).toThrow('not authorized');
    expect(cfg.resolveTTSModel('openai-tts', ' speech ')).toBe('speech');
  });
  it('OPENAI_API_KEY image reuse honors IMAGE_OPENAI_MODELS and never the chat list', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server');
    vi.stubEnv('OPENAI_MODELS', 'chat');
    vi.stubEnv('IMAGE_OPENAI_MODELS', 'image');
    const cfg = await import('@/lib/server/provider-config');
    expect(cfg.resolveImageModel('openai-image')).toBe('image');
    expect(() => cfg.resolveImageModel('openai-image', 'chat')).toThrow('not authorized');
  });
  it('media/search without lists authorize only the single effective adapter default', async () => {
    for (const prefix of [
      'IMAGE_OPENAI',
      'VIDEO_KLING',
      'TTS_OPENAI',
      'ASR_OPENAI',
      'WEB_SEARCH_CLAUDE',
    ])
      vi.stubEnv(`${prefix}_API_KEY`, 'server');
    const cfg = await import('@/lib/server/provider-config');
    const cases = [
      [cfg.resolveImageModel, 'openai-image', 'gpt-image-2', 'gpt-image-1'],
      [cfg.resolveVideoModel, 'kling', 'kling-v2-6', 'kling-v1-6'],
      [cfg.resolveTTSModel, 'openai-tts', 'gpt-4o-mini-tts', 'tts-1'],
      [cfg.resolveASRModel, 'openai-whisper', 'gpt-4o-mini-transcribe', 'whisper-1'],
    ] as const;
    for (const [resolve, id, defaultId, refused] of cases) {
      expect(resolve(id, '')).toBe(defaultId);
      expect(() => resolve(id, refused)).toThrow('not authorized');
    }
    const { CLAUDE_WEB_SEARCH_DEFAULT_MODEL } = await import('@/lib/web-search/constants');
    expect(cfg.resolveWebSearchModel('claude')).toBe(CLAUDE_WEB_SEARCH_DEFAULT_MODEL);
    expect(() => cfg.resolveWebSearchModel('claude', 'unknown')).toThrow('not authorized');
  });
  it('does not require lists for model-less services', async () => {
    for (const prefix of ['TTS_AZURE', 'TTS_DOUBAO', 'ASR_AZURE', 'TAVILY'])
      vi.stubEnv(`${prefix}_API_KEY`, 'server');
    const cfg = await import('@/lib/server/provider-config');
    expect(cfg.resolveTTSModel('azure-tts', 'ignored')).toBe('ignored');
    expect(cfg.resolveTTSModel('doubao-tts', 'ignored')).toBe('ignored');
    expect(cfg.resolveASRModel('azure-asr', 'ignored')).toBe('ignored');
    expect(cfg.resolveWebSearchModel('tavily', 'ignored')).toBe('ignored');
    cfg.warnMissingServerModelLists();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
  it('warns once at boot without repeating when a separate route module loads', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'server');
    vi.stubEnv('BEDROCK_REGION', 'us-east-1');
    vi.stubEnv('TTS_OPENAI_API_KEY', 'server');
    vi.stubEnv('TTS_AZURE_API_KEY', 'server');
    vi.stubEnv('TAVILY_API_KEY', 'server');
    vi.stubEnv('OLLAMA_BASE_URL', 'https://local.example');
    const cfg = await import('@/lib/server/provider-config');
    for (let i = 0; i < 3; i++) {
      cfg.warnMissingServerModelLists();
      cfg.getServerProviders();
      cfg.getServerImageProviders();
      cfg.resolveTTSApiKey('openai-tts');
    }
    // Instrumentation and app routes have separate module instances in Next.
    vi.resetModules();
    const routeConfig = await import('@/lib/server/provider-config');
    routeConfig.getServerProviders();
    routeConfig.getServerImageProviders();
    const warnings = mocks.warn.mock.calls.map((args) => String(args[0]));
    expect(warnings).toHaveLength(4); // Chat, OpenAI image key reuse, TTS, Bedrock.
    for (const setting of [
      'OPENAI_MODELS',
      'IMAGE_OPENAI_MODELS',
      'TTS_OPENAI_MODELS',
      'BEDROCK_MODELS',
    ])
      expect(warnings.filter((w) => w.includes(`Set ${setting} or`))).toHaveLength(1);
  });
  it('lists suppress startup notices and expose no keys', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'secret');
    vi.stubEnv('OPENAI_MODELS', 'allowed');
    vi.stubEnv('IMAGE_OPENAI_MODELS', 'image');
    const cfg = await import('@/lib/server/provider-config');
    expect(cfg.getServerProviders()).toEqual({ openai: { models: ['allowed'] } });
    cfg.warnMissingServerModelLists();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
