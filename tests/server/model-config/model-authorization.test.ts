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
