import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy downstream of resolveModel so the test isolates the model
// string *resolution order*: stage route > x-model > DEFAULT_MODEL > builtin.
// model-routes is left real (it just reads MODEL_ROUTES) so we exercise the
// real integration point.
// Use the real parseModelString (canonical `provider:model` colon format) so
// the test exercises actual separator handling; only stub getModel (recording
// its args) so no real provider client is constructed. provider-config stubs
// echo the client-supplied key/baseUrl so a test can assert they are dropped
// when a stage route overrides the client model.
const mocks = vi.hoisted(() => ({ getModelCalls: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    getModel: (args: Record<string, unknown>) => {
      mocks.getModelCalls.push(args);
      return { model: { id: args.modelId }, modelInfo: undefined };
    },
  };
});

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => false,
  resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
  resolveProxy: () => undefined,
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: async () => null,
}));

describe('resolveModel — per-stage resolution order', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getModelCalls.length = 0;
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('throws (no hardcoded fallback) when nothing is configured', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(resolveModel({ stage: 'scene-content' })).rejects.toThrow(
      /No model could be resolved/,
    );
  });

  it('uses DEFAULT_MODEL when no stage route matches', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('uses the stage route over DEFAULT_MODEL', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('uses DEFAULT_MODEL for stages not listed in MODEL_ROUTES', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'quiz-grade' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('lets a configured stage route win over an explicit modelString (x-model)', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('falls back to x-model for a stage that is not routed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'quiz-grade', modelString: 'anthropic:claude-sonnet-4' });
    expect(r.modelString).toBe('anthropic:claude-sonnet-4');
  });

  it('drops client apiKey/baseUrl/providerType when a stage route overrides the client model', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      stage: 'pbl-chat',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-openai-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    const call = mocks.getModelCalls.at(-1)!;
    expect(call.providerId).toBe('anthropic');
    expect(call.modelId).toBe('claude-sonnet-4');
    // None of the client-sent connection params for the OLD provider leak onto
    // the routed provider — they resolve from server config instead.
    expect(call.providerType).toBeUndefined();
    expect(call.baseUrl).toBeUndefined();
    expect(call.apiKey).toBe('server-key');
  });

  it('keeps client apiKey/baseUrl/providerType for an unrouted stage (x-model honored)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await resolveModel({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'https://client.example/v1',
      providerType: 'openai',
    });
    const call = mocks.getModelCalls.at(-1)!;
    expect(call.providerType).toBe('openai');
    expect(call.baseUrl).toBe('https://client.example/v1');
    expect(call.apiKey).toBe('client-key');
  });

  it('uses a scene-content:<type> route over the base route and x-model', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content': 'openai:gpt-5.4-mini',
      'scene-content:quiz': 'openai:gpt-5.4',
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content:quiz',
      modelString: 'anthropic:claude-sonnet-4',
    });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('falls back to the base scene-content route for an unrouted type', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content:slide' });
    expect(r.modelString).toBe('openai:gpt-5.4');
  });

  it('resolves the stage route provider for cross-provider routing', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'pbl-chat': 'anthropic:claude-sonnet-4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'pbl-chat' });
    expect(r.modelString).toBe('anthropic:claude-sonnet-4');
    expect(r.providerId).toBe('anthropic');
    expect(r.modelId).toBe('claude-sonnet-4');
  });

  it('route thinking wins over client thinking when the stage is routed', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'pbl-chat': { model: 'anthropic:claude-sonnet-4', thinking: { effort: 'high' } },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'pbl-chat', thinkingConfig: { effort: 'low' } });
    expect(r.thinkingConfig).toEqual({ effort: 'high' });
  });

  it('route can pass a full thinking config (enabled + budgetTokens)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'scene-content:interactive': {
        model: 'qwen:qwen3.7-plus',
        thinking: { enabled: true, budgetTokens: 8000 },
      },
    });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content:interactive' });
    expect(r.thinkingConfig).toEqual({ enabled: true, budgetTokens: 8000 });
  });

  it('routed-without-thinking drops client thinking (routed model uses its default)', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content', thinkingConfig: { effort: 'high' } });
    expect(r.thinkingConfig).toBeUndefined();
  });

  it('unrouted stage keeps the client thinking config', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'deepseek:deepseek-v4-pro' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'quiz-grade',
      modelString: 'openai:gpt-5.4-mini',
      thinkingConfig: { effort: 'medium' },
    });
    expect(r.thinkingConfig).toEqual({ effort: 'medium' });
  });

  it('ignores stage routing entirely when no stage is passed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({});
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });
});
