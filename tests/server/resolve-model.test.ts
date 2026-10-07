import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeploymentLayer } from '@/lib/server/model-config/deployment-layer';
import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

// Resolution order for a stage (RFC #1701): the configured slot (a lock, the
// workspace's choice, a server default such as DEFAULT_MODEL), except that the
// model the request names (deprecated) replaces a server default or nothing;
// else a loud error. Only getModel is stubbed
// (recording its args), so no provider client is built; provider-config stubs
// echo the client key and base URL so a test can see whether they were used.
const mocks = vi.hoisted(() => ({
  getModelCalls: [] as Array<Record<string, unknown>>,
  serverManaged: false,
  deployment: { layer: null, legacy: false, notices: [] } as DeploymentLayer,
  workspace: null as ModelConfigLayer | null,
}));

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
  isServerConfiguredProvider: () => mocks.serverManaged,
  resolveApiKey: (_id: string, clientKey: string) => clientKey || 'server-key',
  resolveBaseUrl: (_id: string, clientBaseUrl?: string) => clientBaseUrl,
  resolveProxy: () => undefined,
}));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: async () => null,
  validateClientBaseUrl: async () => null,
}));

const operator: ModelConfigLayer = {
  source: 'deployment',
  config: { providers: { openai: { preset: 'openai', apiKey: 'sk-operator' } } },
};
// What DEFAULT_MODEL translates to: the operator's providers and the default model.
const legacyDefault: ModelConfigLayer = {
  source: 'deployment',
  config: { ...operator.config, slots: { llm: 'openai:gpt-5.6', agent: null } },
};

describe('resolveModel', () => {
  beforeEach(async () => {
    vi.resetModules();
    mocks.getModelCalls.length = 0;
    mocks.serverManaged = false;
    mocks.deployment = { layer: null, legacy: false, notices: [] };
    mocks.workspace = null;
    const runtime = await import('@/lib/server/model-config/runtime');
    // Read at lookup time, so a case can set mocks.deployment after this.
    runtime.setDeploymentConfigForTests({
      get layer() {
        return mocks.deployment.layer;
      },
      get legacy() {
        return mocks.deployment.legacy;
      },
      notices: [],
    });
    runtime.setWorkspaceLayerLoaderForTests(async () => mocks.workspace);
  });

  afterEach(async () => {
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    runtime.setWorkspaceLayerLoaderForTests();
  });

  it('fails loudly when nothing is configured and the request names nothing', async () => {
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(resolveModel({ stage: 'scene-content' })).rejects.toThrow(
      /No model is configured for course.content/,
    );
    await expect(resolveModel({})).rejects.toThrow(/the request names none/);
  });

  it('uses the legacy default model when the request names nothing', async () => {
    mocks.deployment = { layer: legacyDefault, legacy: true, notices: [] };
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content' });
    expect(r).toMatchObject({ modelString: 'openai:gpt-5.6', apiKey: 'sk-operator' });
  });

  it('lets the model the request names win over the legacy default, as before', async () => {
    mocks.deployment = { layer: legacyDefault, legacy: true, notices: [] };
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'scene-content', modelString: 'openai:gpt-5.4-mini' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('lets a configured slot win over everything the request names', async () => {
    mocks.deployment = { layer: legacyDefault, legacy: true, notices: [] };
    mocks.workspace = {
      source: 'workspace',
      config: {
        providers: { ds: { preset: 'deepseek', apiKey: 'sk-user' } },
        slots: { 'course.content': { model: 'ds:deepseek-v4-pro', thinking: { enabled: false } } },
      },
    };
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({
      stage: 'scene-content:quiz',
      workspaceId: 'user:alice',
      modelString: 'openai:gpt-5.4-mini',
      apiKey: 'client-key',
      baseUrl: 'https://client.example/v1',
      thinkingConfig: { effort: 'high' },
      userRoutes: { 'scene-content': { model: 'anthropic:claude-sonnet-4' } },
    });
    expect(r).toMatchObject({
      modelString: 'deepseek:deepseek-v4-pro',
      apiKey: 'sk-user',
      thinkingConfig: { enabled: false },
      serverManaged: true,
    });
    expect(mocks.getModelCalls.at(-1)).toMatchObject({ providerId: 'deepseek', apiKey: 'sk-user' });
  });

  it('reads no workspace settings without a workspace', async () => {
    mocks.workspace = {
      source: 'workspace',
      config: {
        providers: { ds: { preset: 'deepseek', apiKey: 'sk-user' } },
        slots: { llm: 'ds:deepseek-v4-pro' },
      },
    };
    const { resolveModel } = await import('@/lib/server/resolve-model');
    const r = await resolveModel({ stage: 'quiz-grade', modelString: 'openai:gpt-5.4-mini' });
    expect(r.modelString).toBe('openai:gpt-5.4-mini');
  });

  it('refuses a request for a slot the configuration turned off', async () => {
    mocks.deployment = {
      layer: { source: 'deployment', config: { slots: { 'course.actions': null } } },
      legacy: false,
      notices: [],
    };
    const { resolveModel } = await import('@/lib/server/resolve-model');
    await expect(
      resolveModel({ stage: 'scene-actions', modelString: 'openai:gpt-5.4-mini' }),
    ).rejects.toThrow(/course.actions capability is turned off/);
    expect(mocks.getModelCalls).toHaveLength(0);
  });

  describe('the model a request names (deprecated)', () => {
    it('keeps the client connection and thinking for its own model', async () => {
      const { resolveModel } = await import('@/lib/server/resolve-model');
      const r = await resolveModel({
        stage: 'quiz-grade',
        modelString: 'openai:gpt-5.4-mini',
        apiKey: 'client-key',
        baseUrl: 'https://client.example/v1',
        providerType: 'openai',
        thinkingConfig: { effort: 'medium' },
      });
      const call = mocks.getModelCalls.at(-1)!;
      expect(call.providerType).toBe('openai');
      expect(call.baseUrl).toBe('https://client.example/v1');
      expect(call.apiKey).toBe('client-key');
      expect(r.thinkingConfig).toEqual({ effort: 'medium' });
      // A client model on an unmanaged provider must not burn the operator's fallback.
      expect(r.serverManaged).toBe(false);
    });

    it('lets a user route win over the client x-model for its stage, most specific key first', async () => {
      const { resolveModel } = await import('@/lib/server/resolve-model');
      const r = await resolveModel({
        stage: 'scene-content:quiz',
        modelString: 'openai:gpt-5.4-mini',
        thinkingConfig: { effort: 'high' },
        userRoutes: {
          'scene-content': { model: 'openai:gpt-5.4' },
          'scene-content:quiz': { model: 'anthropic:claude-sonnet-4' },
        },
      });
      expect(r.modelString).toBe('anthropic:claude-sonnet-4');
      // The client's thinking belongs to its main model.
      expect(r.thinkingConfig).toBeUndefined();
    });

    it('uses the user route own connection params for the routed provider', async () => {
      const { resolveModel } = await import('@/lib/server/resolve-model');
      await resolveModel({
        stage: 'chat-adapter',
        modelString: 'openai:gpt-5.4-mini',
        apiKey: 'client-openai-key',
        baseUrl: 'https://client.example/v1',
        providerType: 'openai',
        userRoutes: {
          'chat-adapter': {
            model: 'anthropic:claude-sonnet-4',
            apiKey: 'user-anthropic-key',
            baseUrl: 'https://user.example/v1',
            providerType: 'anthropic',
          },
        },
      });
      const call = mocks.getModelCalls.at(-1)!;
      expect(call.providerId).toBe('anthropic');
      expect(call.modelId).toBe('claude-sonnet-4');
      expect(call.providerType).toBe('anthropic');
      expect(call.baseUrl).toBe('https://user.example/v1');
      expect(call.apiKey).toBe('user-anthropic-key');
    });

    it('rejects Bedrock unless the server operator explicitly enabled it', async () => {
      const { resolveModel } = await import('@/lib/server/resolve-model');
      await expect(
        resolveModel({
          modelString: 'bedrock:us.anthropic.claude-sonnet-5',
          apiKey: 'client-supplied-token',
        }),
      ).rejects.toThrow(/must be enabled by the server operator/);
      expect(mocks.getModelCalls).toHaveLength(0);
    });

    it('rejects a client-supplied Bedrock type for another built-in provider', async () => {
      const { resolveModel } = await import('@/lib/server/resolve-model');
      await expect(
        resolveModel({ modelString: 'ollama:llama3.3', providerType: 'bedrock' }),
      ).rejects.toThrow(/Provider type mismatch/);
      expect(mocks.getModelCalls).toHaveLength(0);
    });

    it('allows Bedrock after the server operator explicitly enables it', async () => {
      mocks.serverManaged = true;
      const { resolveModel } = await import('@/lib/server/resolve-model');
      const result = await resolveModel({ modelString: 'bedrock:us.anthropic.claude-sonnet-5' });
      expect(result.providerId).toBe('bedrock');
      expect(result.serverManaged).toBe(true);
      expect(mocks.getModelCalls.at(-1)).toMatchObject({
        providerId: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-5',
      });
    });
  });
});
