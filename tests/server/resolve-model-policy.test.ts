import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Under `policy.allowWorkspaceProviders: false` the deprecated request fields
// (x-model, x-api-key, x-base-url) never pick the model: only providers
// openmaic.yml declares are used.

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

vi.mock('@/lib/server/provider-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/provider-config')>()),
  isServerConfiguredProvider: () => false,
  resolveApiKey: (_id: string, clientKey: string) => clientKey,
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
  resolveProxy: () => undefined,
}));

vi.mock('@/lib/server/ssrf-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ssrf-guard')>()),
  validateClientBaseUrl: async () => null,
  validateUrlForSSRF: async () => null,
}));

const runtime = await import('@/lib/server/model-config/runtime');
const { resolveModel, REQUEST_PROVIDERS_REFUSED } = await import('@/lib/server/resolve-model');

const request = {
  modelString: 'openai:gpt-4o-mini',
  apiKey: 'caller-key',
  baseUrl: 'https://llm.example/v1',
};

function deployment(config: import('@/lib/server/model-config/openmaic-yml').ModelConfigFile) {
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config },
    defaults: null,
    notices: [],
  });
}

beforeEach(() => {
  mocks.getModelCalls.length = 0;
  vi.stubEnv('DATABASE_URL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  runtime.setDeploymentConfigForTests();
});

describe('resolveModel under policy.allowWorkspaceProviders: false', () => {
  it("ignores the request's model and key: an unassigned stage stays unassigned", async () => {
    deployment({ policy: { allowWorkspaceProviders: false } });
    await expect(
      resolveModel({ ...request, stage: 'quiz-grade', workspaceId: null }),
    ).rejects.toBeInstanceOf(runtime.SlotUnassignedError);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it("uses the deployment's model, never the request's", async () => {
    deployment({
      policy: { allowWorkspaceProviders: false },
      providers: { op: { preset: 'openai', apiKey: 'operator-key' } },
      slots: { llm: 'op:gpt-4o' },
    });
    const resolved = await resolveModel({ ...request, stage: 'quiz-grade', workspaceId: null });
    expect(resolved).toMatchObject({ modelId: 'gpt-4o', apiKey: 'operator-key' });
    expect(mocks.getModelCalls.every((call) => call.apiKey !== 'caller-key')).toBe(true);
  });

  it('refuses a model the request names outside any stage (verify-model)', async () => {
    deployment({ policy: { allowWorkspaceProviders: false } });
    await expect(resolveModel(request)).rejects.toThrow(REQUEST_PROVIDERS_REFUSED);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  it.each([true, undefined])('honours the request while the policy is %s', async (allow) => {
    deployment(allow === undefined ? {} : { policy: { allowWorkspaceProviders: allow } });
    const resolved = await resolveModel({ ...request, stage: 'quiz-grade', workspaceId: null });
    expect(resolved).toMatchObject({ modelId: 'gpt-4o-mini', apiKey: 'caller-key' });
    expect((await resolveModel(request)).apiKey).toBe('caller-key');
  });
});
