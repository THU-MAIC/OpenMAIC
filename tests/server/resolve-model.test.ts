import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy downstream of resolveModel so the test isolates the model
// string *resolution order*: x-model > stage route > DEFAULT_MODEL > builtin.
// model-routes is left real (it just reads MODEL_ROUTES) so we exercise the
// real integration point.
// Use the real parseModelString (canonical `provider:model` colon format) so
// the test exercises actual separator handling; only stub getModel so no real
// provider client is constructed.
vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    getModel: ({ modelId }: { modelId: string }) => ({
      model: { id: modelId },
      modelInfo: undefined,
    }),
  };
});

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: () => true,
  resolveApiKey: () => 'key',
  resolveBaseUrl: () => undefined,
  resolveProxy: () => undefined,
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: async () => null,
}));

describe('resolveModel — per-stage resolution order', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('falls back to the builtin default when nothing is configured', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r.modelString).toBe('gpt-5.4-mini');
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

  it('lets an explicit modelString (x-model) win over the stage route', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content', modelString: 'anthropic:claude-sonnet-4' });
    expect(r.modelString).toBe('anthropic:claude-sonnet-4');
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

  it('ignores stage routing entirely when no stage is passed', async () => {
    process.env.DEFAULT_MODEL = 'openai:gpt-5.4-mini';
    process.env.MODEL_ROUTES = JSON.stringify({ 'scene-content': 'openai:gpt-5.4' });
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({});
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });
});
