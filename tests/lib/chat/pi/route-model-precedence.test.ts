import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';

// /api/chat/pi resolves the chat-adapter stage from the request body, the
// user's per-stage routes in `x-model-routes`, and the deployment's slots. The
// real resolveModel is used (with its provider plumbing stubbed) so these
// tests assert the model the route actually hands to the Pi runtime.

const mocks = vi.hoisted(() => ({
  getModelCalls: [] as Array<Record<string, unknown>>,
  runPiDirectorLoop: vi.fn(),
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

vi.mock('@/lib/chat/pi/director-loop', () => ({
  runPiDirectorLoop: mocks.runPiDirectorLoop,
}));

function makeRequest(model: string, modelRoutes?: Record<string, unknown>): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (modelRoutes) headers['x-model-routes'] = JSON.stringify(modelRoutes);
  return new Request('http://localhost/api/chat/pi', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }],
      storeState: { stage: null, scenes: [], currentSceneId: null, mode: 'playback' },
      config: {
        agentIds: ['teacher'],
        agentConfigs: [
          { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Teach', allowedActions: [] },
        ],
      },
      model,
      apiKey: 'body-key',
      providerType: 'openai',
    }),
  }) as unknown as NextRequest;
}

async function deployment(config: ModelConfigFile | null) {
  (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests({
    layer: config ? { source: 'deployment', config } : null,
    legacy: false,
    notices: [],
  });
}

async function post(request: NextRequest) {
  const { POST } = await import('@/app/api/chat/pi/route');
  const response = await POST(request);
  await response.text();
  return response;
}

function expectRuntimeModel(modelId: string) {
  expect(mocks.runPiDirectorLoop).toHaveBeenCalledOnce();
  expect(mocks.runPiDirectorLoop.mock.calls[0][0]).toMatchObject({
    languageModel: { id: modelId },
  });
}

describe('POST /api/chat/pi — classroom model precedence', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.getModelCalls.length = 0;
    mocks.runPiDirectorLoop.mockReset();
    mocks.runPiDirectorLoop.mockResolvedValue(undefined);
    await deployment(null);
  });

  afterEach(async () => {
    (await import('@/lib/server/model-config/runtime')).setDeploymentConfigForTests();
  });

  it('resolves chat-adapter from the user route over the body model', async () => {
    const response = await post(
      makeRequest('openai:gpt-5.4-mini', {
        'chat-adapter': { model: 'anthropic:claude-sonnet-4' },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      apiKey: 'server-key',
    });
    expectRuntimeModel('claude-sonnet-4');
  });

  it('lets a locked classroom slot win over the user route', async () => {
    await deployment({
      providers: { openai: { preset: 'openai', apiKey: 'sk-operator' } },
      slots: { classroom: 'openai:gpt-5.4' },
      lock: ['classroom'],
    });
    const response = await post(
      makeRequest('openai:gpt-5.4-mini', {
        'chat-adapter': { model: 'anthropic:claude-sonnet-4' },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.4',
      apiKey: 'sk-operator',
    });
    expectRuntimeModel('gpt-5.4');
  });

  it('falls back to the body model when no user route matches the stage', async () => {
    const response = await post(
      makeRequest('openai:gpt-5.4-mini', {
        'quiz-grade': { model: 'anthropic:claude-sonnet-4' },
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'openai',
      modelId: 'gpt-5.4-mini',
    });
    expectRuntimeModel('gpt-5.4-mini');
  });

  it('retains the locked classroom model despite unlisted body and user-route models', async () => {
    await deployment({
      providers: { openai: { preset: 'openai', apiKey: 'sk-operator', models: ['allowed'] } },
      slots: { classroom: 'openai:primary' },
      lock: ['classroom'],
    });
    const response = await post(
      makeRequest('openai:unlisted', { 'chat-adapter': { model: 'openai:unlisted' } }),
    );

    expect(response.status).toBe(200);
    expect(mocks.getModelCalls.at(-1)).toMatchObject({
      providerId: 'openai',
      modelId: 'primary',
      apiKey: 'sk-operator',
    });
    expectRuntimeModel('primary');
  });
});
