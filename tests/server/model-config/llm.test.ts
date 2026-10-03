import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigLayer, SlotResolution } from '@/lib/server/model-config/resolve-slot';
import type { ResolvedModel } from '@/lib/server/resolve-model';

const state = vi.hoisted(() => ({ lookup: undefined as SlotResolution | undefined }));

vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/model-config/runtime')>()),
  lookupStage: vi.fn(async () => state.lookup),
}));

const { lookupFromLayers, SlotDisabledError, SlotUnassignedError } =
  await import('@/lib/server/model-config/runtime');
const { resolveStageModel } = await import('@/lib/server/model-config/llm');

const layer = (source: ModelConfigLayer['source'], config: ModelConfigLayer['config']) => ({
  source,
  config,
});

const legacyModel = { modelString: 'openai:from-header' } as ResolvedModel;

describe('resolveStageModel', () => {
  beforeEach(() => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', '');
  });

  it('builds the configured model with its options', async () => {
    state.lookup = lookupFromLayers('course.content.slide', {
      deployment: null,
      workspace: layer('workspace', {
        providers: { ds: { preset: 'deepseek', apiKey: 'sk-user' } },
        slots: {
          'course.content': {
            model: 'ds:deepseek-v4-pro',
            thinking: { enabled: false },
            fallback: 'ds:deepseek-v4-flash',
          },
        },
      }),
    });
    const legacyRequest = vi.fn(async () => legacyModel);
    const resolved = await resolveStageModel({
      stage: 'scene-content:slide',
      workspaceId: 'user:alice',
      legacyRequest,
    });
    expect(resolved).toMatchObject({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-pro',
      modelString: 'deepseek:deepseek-v4-pro',
      apiKey: 'sk-user',
      thinkingConfig: { enabled: false },
      serverManaged: true,
      resolution: { fallback: { modelId: 'deepseek-v4-flash' } },
    });
    // The request's own choice is not even looked at.
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it('fails loudly on a slot that is turned off, whatever the request names', async () => {
    state.lookup = lookupFromLayers('course.actions', {
      deployment: layer('deployment', { slots: { llm: null } }),
      workspace: null,
    });
    const legacyRequest = vi.fn(async () => legacyModel);
    await expect(
      resolveStageModel({ stage: 'scene-actions', workspaceId: null, legacyRequest }),
    ).rejects.toBeInstanceOf(SlotDisabledError);
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it("keeps openmaic.yml's default over what the request names, and a legacy default under it", async () => {
    const { setDeploymentConfigForTests } = await import('@/lib/server/model-config/runtime');
    const deployment = layer('deployment', {
      providers: { openai: { preset: 'openai', apiKey: 'sk-operator' } },
      slots: { llm: 'openai:gpt-5.6' },
    });
    state.lookup = lookupFromLayers('course.outline', { deployment, workspace: null });
    const run = (legacyRequest: () => Promise<ResolvedModel | undefined>) =>
      resolveStageModel({ stage: 'scene-outlines-stream', workspaceId: null, legacyRequest });
    try {
      // openmaic.yml: its default stands.
      setDeploymentConfigForTests({ layer: deployment, legacy: false, notices: [] });
      expect(await run(async () => legacyModel)).toMatchObject({ modelId: 'gpt-5.6' });
      // The same default translated from DEFAULT_MODEL: the request's model first, as before.
      setDeploymentConfigForTests({ layer: deployment, legacy: true, notices: [] });
      expect(await run(async () => legacyModel)).toBe(legacyModel);
      expect(await run(async () => undefined)).toMatchObject({
        modelId: 'gpt-5.6',
        apiKey: 'sk-operator',
      });
      // A workspace choice or a lock is never replaced.
      const legacyRequest = vi.fn(async () => legacyModel);
      for (const lookup of [
        lookupFromLayers('course.outline', {
          deployment,
          workspace: layer('workspace', { slots: { 'course.outline': 'openai:gpt-5.6-mini' } }),
        }),
        lookupFromLayers('course.outline', {
          deployment: layer('deployment', { ...deployment.config, lock: ['llm'] }),
          workspace: null,
        }),
      ]) {
        state.lookup = lookup;
        await expect(run(legacyRequest)).resolves.toMatchObject({ providerId: 'openai' });
      }
      expect(legacyRequest).not.toHaveBeenCalled();
    } finally {
      setDeploymentConfigForTests();
    }
  });

  it('says so when nothing resolves', async () => {
    state.lookup = lookupFromLayers('llm', { deployment: null, workspace: null });
    await expect(
      resolveStageModel({ stage: 'chat-adapter', workspaceId: null }),
    ).rejects.toBeInstanceOf(SlotUnassignedError);
  });

  it('refuses Bedrock and proxies from a workspace, where the deployment may set them', async () => {
    const ws = (provider: Record<string, unknown>) =>
      lookupFromLayers('llm', {
        deployment: null,
        workspace: layer('workspace', {
          providers: { p: provider },
          slots: { llm: 'p:m' },
        } as never),
      });
    state.lookup = ws({ preset: 'bedrock' });
    await expect(
      resolveStageModel({ stage: 'chat-adapter', workspaceId: 'u' }),
    ).rejects.toMatchObject({
      code: 'MODEL_CONFIG_INVALID',
      message: expect.stringMatching(/Amazon Bedrock can only be configured by the deployment/),
    });
    state.lookup = ws({ preset: 'openai', apiKey: 'k', proxy: 'http://10.0.0.1:3128' });
    await expect(resolveStageModel({ stage: 'chat-adapter', workspaceId: 'u' })).rejects.toThrow(
      /A proxy can only be configured by the deployment/,
    );
    state.lookup = lookupFromLayers('llm', {
      deployment: layer('deployment', {
        providers: { p: { preset: 'openai', apiKey: 'k', proxy: 'http://10.0.0.1:3128' } },
        slots: { llm: 'p:m' },
      }),
      workspace: null,
    });
    await expect(
      resolveStageModel({ stage: 'chat-adapter', workspaceId: null }),
    ).resolves.toMatchObject({ modelId: 'm' });
  });

  it('attaches no retry when the fallback cannot meet the slot either', async () => {
    const { attachedModelFallback } = await import('@/lib/ai/model-fallbacks');
    state.lookup = lookupFromLayers('agent', {
      deployment: null,
      workspace: layer('workspace', {
        providers: {
          td: { preset: 'tokendance', apiKey: 'k' },
          ac: { preset: 'atlascloud', apiKey: 'k' },
        },
        slots: { agent: { model: 'td:deepseek-v4-pro', fallback: 'ac:qwen/qwen3.5-flash' } },
      }),
    });
    const resolved = await resolveStageModel({ stage: 'maic-agent-driver', workspaceId: 'u' });
    expect(await attachedModelFallback(resolved.model)!()).toBeNull();
  });

  it('refuses a model the catalogue says cannot meet the slot, before any fallback', async () => {
    state.lookup = lookupFromLayers('agent', {
      deployment: null,
      workspace: layer('workspace', {
        providers: { ac: { preset: 'atlascloud', apiKey: 'k' } },
        slots: { agent: 'ac:qwen/qwen3.5-flash' },
      }),
    });
    const legacyRequest = vi.fn(async () => legacyModel);
    await expect(
      resolveStageModel({ stage: 'maic-agent-driver', workspaceId: 'u', legacyRequest }),
    ).rejects.toThrow(/does not meet its requirement \(toolCalling\)/);
    expect(legacyRequest).not.toHaveBeenCalled();
  });

  it("never lends a workspace provider the deployment's key", async () => {
    state.lookup = lookupFromLayers('llm', {
      deployment: layer('deployment', {
        providers: { deepseek: { preset: 'deepseek', apiKey: 'sk-operator' } },
      }),
      // A workspace provider of the same vendor whose key did not open.
      workspace: layer('workspace', {
        providers: { mine: { preset: 'deepseek' } },
        slots: { llm: 'mine:deepseek-v4-pro' },
      }),
    });
    await expect(
      resolveStageModel({ stage: 'chat-adapter', workspaceId: 'u' }),
    ).rejects.toMatchObject({
      name: 'ModelConfigurationError',
      code: 'MISSING_API_KEY',
      message: expect.stringMatching(/API key required/),
    });
  });

  it('checks a workspace endpoint like a caller-supplied one, and trusts the deployment', async () => {
    const provider = {
      preset: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'local',
    };
    state.lookup = lookupFromLayers('llm', {
      deployment: null,
      workspace: layer('workspace', { providers: { local: provider }, slots: { llm: 'local:m' } }),
    });
    await expect(
      resolveStageModel({ stage: 'chat-adapter', workspaceId: 'u' }),
    ).rejects.toMatchObject({
      code: 'INVALID_URL',
      message: expect.stringMatching(/Local\/private network URLs are not allowed/),
    });
    state.lookup = lookupFromLayers('llm', {
      deployment: layer('deployment', {
        providers: { local: provider },
        slots: { llm: 'local:m' },
      }),
      workspace: null,
    });
    await expect(
      resolveStageModel({ stage: 'chat-adapter', workspaceId: null }),
    ).resolves.toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'm' });
  });
});
