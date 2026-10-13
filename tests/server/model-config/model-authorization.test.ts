import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ModelConfigFile } from '@/lib/server/model-config/openmaic-yml';
import {
  assertDeploymentModelAuthorized,
  ModelAuthorizationError,
} from '@/lib/server/model-config/model-authorization';

const mocks = vi.hoisted(() => ({
  getModel: vi.fn(() => ({ model: { id: 'stub' } })),
  callLLM: vi.fn(async () => ({ text: 'OK' })),
  generate: vi.fn(async function* () {}),
  pi: vi.fn(async () => {}),
  invalidOwner: false,
  workspaceId: null as string | null,
}));
vi.mock('@/lib/ai/providers', async (original) => ({
  ...(await original<typeof import('@/lib/ai/providers')>()),
  getModel: mocks.getModel,
}));
vi.mock('@/lib/server/provider-config', async (original) => ({
  ...(await original<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: (_section: string, id: string) =>
    ['openai', 'anthropic'].includes(id),
  resolveApiKey: (id: string, own: string) =>
    ['openai', 'anthropic'].includes(id) ? 'server-secret' : own,
  resolveBaseUrl: (_id: string, own?: string) => own,
  resolveProxy: () => undefined,
}));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/orchestration/stateless-generate', () => ({ statelessGenerate: mocks.generate }));
vi.mock('@/lib/chat/pi/director-loop', () => ({ runPiDirectorLoop: mocks.pi }));
vi.mock('@/lib/server/identity/resolve', async (original) => ({
  ...(await original<typeof import('@/lib/server/identity/resolve')>()),
  resolveRequestOwner: async () =>
    mocks.invalidOwner
      ? { ok: false }
      : { ok: true, principal: { ownerId: 'test-owner', assurance: 'minted' } },
}));
vi.mock('@/lib/server/ssrf-guard', async (original) => ({
  ...(await original<typeof import('@/lib/server/ssrf-guard')>()),
  validateClientBaseUrl: async () => null,
  validateUrlForSSRF: async () => null,
}));
vi.mock('@/lib/server/model-config/runtime', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/runtime')>()),
  // Identity/database boundary only; slot lookup and model resolution stay real.
  requestWorkspaceId: async () => mocks.workspaceId,
}));

const runtime = await import('@/lib/server/model-config/runtime');
const { resolveModel } = await import('@/lib/server/resolve-model');
const { resolveSlot } = await import('@/lib/server/model-config/resolve-slot');
const { POST: verify } = await import('@/app/api/verify-model/route');
const { POST: chat } = await import('@/app/api/chat/route');
const { POST: pi } = await import('@/app/api/chat/pi/route');

function deployment(config: ModelConfigFile, legacy = false) {
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    legacy,
    notices: [],
  });
}
function request(body: unknown, routes?: unknown) {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(routes ? { 'x-model-routes': JSON.stringify(routes) } : {}),
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}
function chatBody(model: string) {
  return {
    model,
    messages: [],
    storeState: { scenes: [] },
    config: {
      agentIds: ['teacher'],
      agentConfigs: [
        { id: 'teacher', name: 'Teacher', role: 'teacher', persona: 'Teach', allowedActions: [] },
      ],
    },
  };
}
const config: ModelConfigFile = {
  providers: { openai: { preset: 'openai', apiKey: 'server-secret', models: ['allowed'] } },
  slots: { llm: { model: 'openai:primary', fallback: 'openai:backup' } },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.invalidOwner = false;
  vi.stubEnv('OPENAI_API_KEY', 'server-secret');
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('NEXT_PUBLIC_PI_CHAT_ENABLED', 'true');

  deployment(config, true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  runtime.setDeploymentConfigForTests();
});

describe('operator model authorization', () => {
  it('allows only explicitly configured models, including primary and fallback', () => {
    for (const id of ['allowed', 'primary', 'backup'])
      expect(() => assertDeploymentModelAuthorized(config, 'openai', id)).not.toThrow();
    for (const id of ['gpt-4o', 'unknown', 'allowed '])
      expect(() => assertDeploymentModelAuthorized(config, 'openai', id)).toThrow(
        ModelAuthorizationError,
      );
    expect(() =>
      assertDeploymentModelAuthorized(
        { providers: { openai: { preset: 'openai' } } },
        'openai',
        'gpt-4o',
      ),
    ).toThrow(ModelAuthorizationError);
    expect(() => assertDeploymentModelAuthorized(config, 'constructor', 'allowed')).toThrow(
      ModelAuthorizationError,
    );
  });
  it('refuses an unauthorized workspace primary or fallback using a deployment key', () => {
    for (const assignment of [
      'openai:unlisted',
      { model: 'openai:allowed', fallback: 'openai:unlisted' },
    ]) {
      expect(() =>
        resolveSlot('classroom', [
          { source: 'deployment', config },
          {
            source: 'workspace',
            config: {
              providers: { openai: { preset: 'openai', models: ['unlisted'], apiKey: 'own' } },
              slots: { classroom: assignment },
            },
          },
        ]),
      ).toThrow(ModelAuthorizationError);
    }
  });
  it('does not let another provider borrow the first provider authorization', async () => {
    const response = await verify(request({ model: 'anthropic:allowed' }));
    expect(response.status).toBe(403);
    expect(mocks.getModel).not.toHaveBeenCalled();
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'refuses a provider with no authorized models (saved=%s)',
    async (saved) => {
      deployment(
        {
          providers: config.providers && { openai: { preset: 'openai', apiKey: 'server-secret' } },
        },
        true,
      );
      const response = await verify(
        request(saved ? { provider: 'openai', model: 'gpt-4o' } : { model: 'openai:gpt-4o' }),
      );
      expect(response.status).toBe(403);
      expect(mocks.callLLM).not.toHaveBeenCalled();
      expect(mocks.getModel).not.toHaveBeenCalled();
    },
  );
  it('retains the locked classroom model despite body and header overrides', async () => {
    deployment({ ...config, slots: { classroom: 'openai:primary' }, lock: ['classroom'] });
    const response = await chat(
      request(chatBody('openai:unlisted'), { 'chat-adapter': 'openai:unlisted' }),
    );
    await response.text();
    expect(response.status).toBe(200);
    expect(mocks.getModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'primary' }));
  });
  it('keeps user-key policy and BYOK behavior', async () => {
    deployment({ allowUserKeys: false });
    await expect(
      resolveModel({ modelString: 'custom:any', apiKey: 'own', providerType: 'openai' }),
    ).rejects.toThrow();
    expect(mocks.getModel).not.toHaveBeenCalled();
    deployment({});
    await resolveModel({
      modelString: 'custom:any',
      apiKey: 'own',
      providerType: 'openai',
      baseUrl: 'https://example.com/v1',
    });
    expect(mocks.getModel).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'own', modelId: 'any' }),
    );
  });
  it('does not revive legacy keys when YAML replaced their configuration', async () => {
    deployment(config);
    await expect(resolveModel({ modelString: 'openai:allowed' })).rejects.toThrow(
      ModelAuthorizationError,
    );
    expect(mocks.getModel).not.toHaveBeenCalled();
  });
  it.each([chat, pi])(
    'rejects chat model and header substitution before generation',
    async (handler) => {
      for (const routed of [false, true]) {
        const response = await handler(
          request(
            chatBody(routed ? 'openai:allowed' : 'openai:unlisted'),
            routed ? { 'chat-adapter': 'openai:unlisted' } : undefined,
          ),
        );
        expect(response.status).toBe(403);
      }
      expect(mocks.getModel).not.toHaveBeenCalled();
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(mocks.pi).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'rejects arbitrary verification models (saved=%s) before upstream work',
    async (saved) => {
      if (saved) deployment({ ...config, allowUserKeys: false, lock: ['classroom'] });
      const response = await verify(
        request(saved ? { provider: 'openai', model: 'unlisted' } : { model: 'openai:unlisted' }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: new ModelAuthorizationError().message });
      expect(mocks.getModel).not.toHaveBeenCalled();
      expect(mocks.callLLM).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])('allows explicitly authorized verification (saved=%s)', async (saved) => {
    const response = await verify(
      request(saved ? { provider: 'openai', model: 'allowed' } : { model: 'openai:allowed' }),
    );
    expect(response.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledOnce();
    expect(mocks.getModel).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'server-secret', modelId: 'allowed' }),
    );
  });
  it.each([false, true])(
    'rejects invalid identity before either verification path (saved=%s)',
    async (saved) => {
      mocks.invalidOwner = true;
      const response = await verify(
        request(saved ? { provider: 'openai', model: 'allowed' } : { model: 'openai:allowed' }),
      );
      expect(response.status).toBe(401);
      expect(mocks.getModel).not.toHaveBeenCalled();
      expect(mocks.callLLM).not.toHaveBeenCalled();
    },
  );
});

describe('Pi classroom tool requirement through real model resolution', () => {
  const noTools = 'qwen/qwen3.5-flash';
  const atlas = { preset: 'atlascloud', apiKey: 'test-key' };

  beforeEach(() => {
    mocks.workspaceId = 'test-owner';
    runtime.setWorkspaceLayerLoaderForTests(async () => null);
  });
  afterEach(() => {
    mocks.workspaceId = null;
    runtime.setWorkspaceLayerLoaderForTests();
  });

  it.each(['classroom', 'llm'] as const)(
    'refuses a tools:false model assigned to %s before building a model or starting SSE',
    async (slot) => {
      deployment({
        providers: { ac: atlas, good: { preset: 'openai', apiKey: 'test-key' } },
        slots: { [slot]: { model: `ac:${noTools}`, fallback: 'good:gpt-5.6' } },
      });
      const response = await pi(request(chatBody('openai:gpt-5.6')));
      expect(response.status).toBe(400);
      expect(response.headers.get('Content-Type')).not.toContain('text/event-stream');
      expect(await response.json()).toMatchObject({
        errorCode: 'MODEL_CONFIG_INVALID',
        reason: 'tool_calling_required',
        error: expect.stringContaining('classroom slot'),
      });
      expect(mocks.getModel).not.toHaveBeenCalled();
      expect(mocks.pi).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['openai', 'gpt-5.6'],
    ['openai', 'not-in-the-catalogue'],
    ['openai-compatible', 'deepseek-r1'],
  ])('allows %s:%s without probing tool support', async (preset, model) => {
    deployment({
      providers: { p: { preset, apiKey: 'test-key', baseUrl: 'https://example.com/v1' } },
      slots: { classroom: `p:${model}` },
    });
    const response = await pi(request(chatBody('ollama:deepseek-r1')));
    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.pi).toHaveBeenCalledOnce();
    expect(mocks.getModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: model }));
  });

  it.each([false, true])('checks a request model or stage override (routed=%s)', async (routed) => {
    deployment({}, true);
    const response = await pi(
      request(
        {
          ...chatBody(routed ? 'custom:unknown' : 'ollama:deepseek-r1'),
          requireToolCalling: false,
        },
        routed ? { 'chat-adapter': { model: 'ollama:deepseek-r1' } } : undefined,
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'tool_calling_required' });
    expect(mocks.pi).not.toHaveBeenCalled();
  });

  it('checks a request model selected over a legacy default, without attaching a fallback', async () => {
    deployment(config, true);
    const response = await pi(request(chatBody('ollama:deepseek-r1')));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'tool_calling_required' });
    expect(mocks.pi).not.toHaveBeenCalled();
    const { attachedModelFallback } = await import('@/lib/ai/model-fallbacks');
    expect(attachedModelFallback(mocks.getModel.mock.results[0].value.model)).toBeUndefined();
  });

  it.each(['custom:unknown-model', 'openai-compatible:gpt-5.6'])(
    'keeps unknown or custom request models passing (%s)',
    async (model) => {
      deployment({}, true);
      const response = await pi(
        request({
          ...chatBody(model),
          apiKey: 'own-key',
          providerType: 'openai',
          baseUrl: 'https://example.com/v1',
        }),
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(mocks.pi).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'keeps YAML configuration authoritative (allowUserKeys=%s)',
    async (allowed) => {
      deployment({ ...config, allowUserKeys: allowed });
      const response = await pi(request(chatBody('ollama:deepseek-r1')));
      expect(response.status).toBe(200);
      await response.text();
      expect(mocks.getModel).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'primary' }));
    },
  );

  it('checks the workspace choice and keeps a locked choice authoritative', async () => {
    const base: ModelConfigFile = {
      providers: { ac: atlas, openai: config.providers!.openai },
      slots: { llm: `ac:${noTools}` },
    };
    runtime.setWorkspaceLayerLoaderForTests(async () => ({
      source: 'workspace',
      config: { slots: { classroom: 'openai:allowed' } },
    }));
    deployment(base);
    const workspaceResponse = await pi(request(chatBody('ollama:deepseek-r1')));
    expect(workspaceResponse.status).toBe(200);
    await workspaceResponse.text();
    mocks.getModel.mockClear();
    mocks.pi.mockClear();
    deployment({ ...base, lock: ['llm'] });
    const lockedResponse = await pi(request(chatBody('openai:allowed')));
    expect(lockedResponse.status).toBe(400);
    expect(await lockedResponse.json()).toMatchObject({
      error: expect.stringContaining('administrator'),
    });
    expect(mocks.getModel).not.toHaveBeenCalled();
    expect(mocks.pi).not.toHaveBeenCalled();
  });

  it('refuses an unauthorized model before the tool requirement', async () => {
    deployment({
      providers: { ac: { ...atlas, models: ['allowed'] } },
      slots: { classroom: 'ac:allowed' },
    });
    runtime.setWorkspaceLayerLoaderForTests(async () => ({
      source: 'workspace',
      config: { slots: { classroom: `ac:${noTools}` } },
    }));
    const response = await pi(request(chatBody('openai:allowed')));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ errorCode: 'PROVIDER_DISABLED' });
    expect(mocks.getModel).not.toHaveBeenCalled();
    expect(mocks.pi).not.toHaveBeenCalled();
  });

  it('keeps the legacy chat route and quiz/PBL stage resolution available without tools', async () => {
    deployment({ providers: { ac: atlas }, slots: { classroom: `ac:${noTools}` } });
    const response = await chat(request(chatBody('openai:allowed')));
    expect(response.status).toBe(200);
    await response.text();
    expect(mocks.generate).toHaveBeenCalledOnce();
    for (const stage of [
      'quiz-grade',
      'pbl-v2-runtime',
      'pbl-v2-runtime:instructor',
      'pbl-v2-runtime:open-task',
      'pbl-v2-runtime:evaluate',
      'pbl-v2-runtime:simulator',
    ] as const) {
      await expect(resolveModel({ stage })).resolves.toMatchObject({ modelId: noTools });
    }
  });
});
