import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// Regression for the classroom-interaction override gap: /api/chat resolves the
// chat-adapter stage from the request body, so it must also forward the user's
// per-stage routes carried by `x-model-routes`. The real resolveModel is used
// (with its provider plumbing stubbed) so the test asserts the model the route
// actually sends to generation, not merely that a function was called.

const mocks = vi.hoisted(() => ({
  getModelCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/ai/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers')>();
  return {
    ...actual,
    isProviderKeyRequired: () => false,
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

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const statelessGenerate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/orchestration/stateless-generate', () => ({
  statelessGenerate,
}));

function makeRequest(model: string, modelRoutes?: string): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (modelRoutes) headers['x-model-routes'] = modelRoutes;
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
      storeState: { stage: null, scenes: [], currentSceneId: null, mode: 'playback' },
      config: { agentIds: ['default-1'] },
      model,
      apiKey: 'body-key',
      providerType: 'openai',
    }),
  }) as unknown as NextRequest;
}

describe('POST /api/chat — per-stage user routes (classroom interaction)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.getModelCalls.length = 0;
    statelessGenerate.mockReset();
    statelessGenerate.mockImplementation(async function* () {});
    delete process.env.MODEL_ROUTES;
    delete process.env.DEFAULT_MODEL;
  });

  it('resolves chat-adapter from the user route over the body model', async () => {
    const { POST } = await import('@/app/api/chat/route');
    const response = await POST(
      makeRequest(
        'openai:gpt-5.4-mini',
        JSON.stringify({ 'chat-adapter': { model: 'anthropic:claude-sonnet-4' } }),
      ),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
    });
    expect(statelessGenerate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'server-key' }),
      expect.anything(),
      { id: 'claude-sonnet-4' },
      expect.anything(),
    );
  });

  it('keeps the operator MODEL_ROUTES route over the user route', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({ 'chat-adapter': 'openai:gpt-5.4' });
    const { POST } = await import('@/app/api/chat/route');
    const response = await POST(
      makeRequest(
        'openai:gpt-5.4-mini',
        JSON.stringify({ 'chat-adapter': { model: 'anthropic:claude-sonnet-4' } }),
      ),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.4',
    });
  });

  it('falls back to the body model when no user route matches the stage', async () => {
    const { POST } = await import('@/app/api/chat/route');
    const response = await POST(
      makeRequest(
        'openai:gpt-5.4-mini',
        JSON.stringify({ 'quiz-grade': { model: 'anthropic:claude-sonnet-4' } }),
      ),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.4-mini',
    });
  });
});
