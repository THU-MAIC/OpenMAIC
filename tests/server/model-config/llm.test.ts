import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigLayer, SlotResolution } from '@/lib/server/model-config/resolve-slot';
import type { ResolvedModel } from '@/lib/server/resolve-model';

const state = vi.hoisted(() => ({ lookup: undefined as SlotResolution | undefined }));

// Fix the DNS boundary; workspace URL and address validation still run through the real SSRF guard.
vi.mock('node:dns', async (original) => {
  const actual = await original<typeof import('node:dns')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    },
  };
});

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
            fallback: 'ds:deepseek-flash',
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
      resolution: { fallback: { modelId: 'deepseek-flash' } },
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
      providers: { openai: { preset: 'openai', apiKey: 'sk-operator', models: ['gpt-5.6-mini'] } },
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

  it.each([
    ['atlascloud', 'qwen/qwen3.5-flash', false],
    ['openai', 'gpt-5.6', true],
    ['openai-compatible', 'unknown-model', true],
  ])('applies Pi tool requirements to the existing %s fallback', async (preset, model, allowed) => {
    const { attachedModelFallback } = await import('@/lib/ai/model-fallbacks');
    state.lookup = lookupFromLayers('classroom', {
      deployment: layer('deployment', {
        providers: {
          primary: { preset: 'openai', apiKey: 'test-key' },
          backup: { preset, apiKey: 'test-key', baseUrl: 'https://example.com/v1' },
        },
        slots: { classroom: { model: 'primary:gpt-5.6', fallback: `backup:${model}` } },
      }),
      workspace: null,
    });
    const resolved = await resolveStageModel({
      stage: 'chat-adapter',
      workspaceId: null,
      requireToolCalling: true,
    });
    const fallback = await attachedModelFallback(resolved.model)!();
    if (allowed) expect(fallback).toMatchObject({ modelString: `openai:${model}` });
    else expect(fallback).toBeNull();
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

describe('Pi Google route on resolved slot targets', () => {
  const official = 'https://generativelanguage.googleapis.com/v1beta/openai';
  it.each([
    ['openai-compatible', official, true],
    ['openai', official + '/', true],
    ['openai', 'https://GENERATIVELANGUAGE.GOOGLEAPIS.COM:443/v1beta/openai?x=1', true],
    ['google', official, false],
    ['google', undefined, false],
    ['openai-compatible', 'https://gateway.example/v1', false],
    ['openai-compatible', official + '.evil.example/v1', false],
    [
      'openai-compatible',
      'https://generativelanguage.googleapis.com.evil.example/v1beta/openai',
      false,
    ],
    [
      'openai-compatible',
      'https://generativelanguage.googleapis.com@evil.example/v1beta/openai',
      false,
    ],
    ['openai-compatible', 'https://example.com/v1?url=' + official, false],
    [
      'openai-compatible',
      'https://example.com/generativelanguage.googleapis.com/v1beta/openai',
      false,
    ],
    ['openai-compatible', 'https://generativelanguage.googleapis.com/v1/openai', false],
    ['openai-compatible', 'https://generativelanguage.googleapis.com/v1beta/openai/extra', false],
    ['openai-compatible', 'https://example-aiplatform.googleapis.com/v1/endpoints/openapi', false],
  ])('checks only the effective %s URL %s (refused=%s)', async (preset, baseUrl, refused) => {
    state.lookup = lookupFromLayers('classroom', {
      deployment: layer('deployment', {
        providers: { p: { preset, apiKey: 'test-key', ...(baseUrl ? { baseUrl } : {}) } },
        slots: { classroom: 'p:google/gemini-alias' },
      }),
      workspace: null,
    });
    const run = resolveStageModel({
      stage: 'chat-adapter',
      workspaceId: null,
      requireToolCalling: true,
    });
    if (refused) await expect(run).rejects.toMatchObject({ name: 'PiGeminiNativeRequiredError' });
    else await expect(run).resolves.toMatchObject({ modelId: 'google/gemini-alias' });
  });
  it.each([undefined, ''])(
    'uses the registry default for an empty effective URL (%s)',
    async (baseUrl) => {
      const providers = await import('@/lib/ai/providers');
      const registry = providers.getProvider('openai')!;
      const getProvider = vi
        .spyOn(providers, 'getProvider')
        .mockImplementation((id) =>
          id === 'openai' ? { ...registry, defaultBaseUrl: official } : undefined,
        );
      try {
        state.lookup = lookupFromLayers('classroom', {
          deployment: layer('deployment', {
            providers: { p: { preset: 'openai', apiKey: 'test-key' } },
            slots: { classroom: 'p:alias' },
          }),
          workspace: null,
        });
        if (state.lookup?.status === 'assigned') state.lookup.baseUrl = baseUrl;
        await expect(
          resolveStageModel({ stage: 'chat-adapter', workspaceId: null, requireToolCalling: true }),
        ).rejects.toMatchObject({ name: 'PiGeminiNativeRequiredError' });
      } finally {
        getProvider.mockRestore();
      }
    },
  );
  it.each([
    ['openai-compatible', official, true, false],
    ['openai-compatible', official, false, true],
    ['google', undefined, true, true],
    ['openai-compatible', 'https://example.com/v1', true, true],
  ])(
    'skips only incompatible Pi fallback (%s, tools=%s)',
    async (preset, baseUrl, requireToolCalling, allowed) => {
      const { attachedModelFallback } = await import('@/lib/ai/model-fallbacks');
      state.lookup = lookupFromLayers('classroom', {
        deployment: layer('deployment', {
          providers: {
            primary: { preset: 'google', apiKey: 'test-key' },
            backup: { preset, apiKey: 'test-key', ...(baseUrl ? { baseUrl } : {}) },
          },
          slots: {
            classroom: { model: 'primary:gemini-3.8-flash', fallback: 'backup:gemini-alias' },
          },
        }),
        workspace: null,
      });
      const resolved = await resolveStageModel({
        stage: 'chat-adapter',
        workspaceId: null,
        requireToolCalling,
      });
      const fallback = await attachedModelFallback(resolved.model)!();
      if (allowed)
        expect(fallback).toMatchObject({ modelString: expect.stringContaining('gemini-alias') });
      else expect(fallback).toBeNull();
    },
  );
});

describe('declared context windows', () => {
  async function resolvesWith(config: ModelConfigLayer['config']) {
    state.lookup = lookupFromLayers('course.content.slide', {
      deployment: null,
      workspace: layer('workspace', config),
    });
    return resolveStageModel({ stage: 'scene-content:slide', workspaceId: 'user:alice' });
  }

  it('uses a declared window for a model the catalogue does not know', async () => {
    const resolved = await resolvesWith({
      providers: {
        relay: {
          preset: 'openai-compatible',
          apiKey: 'sk',
          baseUrl: 'https://relay.example/v1',
          models: ['mystery'],
          modelContextWindows: { mystery: 1_000_000 },
        },
      },
      slots: { 'course.content': 'relay:mystery' },
    });
    expect(resolved.modelInfo).toEqual({
      id: 'mystery',
      name: 'mystery',
      contextWindow: 1_000_000,
    });
  });

  it('leaves an unknown model without metadata when nothing is declared', async () => {
    const resolved = await resolvesWith({
      providers: {
        relay: { preset: 'openai-compatible', apiKey: 'sk', baseUrl: 'https://relay.example/v1' },
      },
      slots: { 'course.content': 'relay:mystery' },
    });
    expect(resolved.modelInfo).toBeNull();
  });

  it('keeps the catalogue window for a model it knows on a trusted provider', async () => {
    const resolved = await resolvesWith({
      providers: {
        o: { preset: 'openai', apiKey: 'sk-test', modelContextWindows: { 'gpt-5.6': 100_000 } },
      },
      slots: { 'course.content': 'o:gpt-5.6' },
    });
    expect(resolved.modelInfo?.contextWindow).toBe(1_050_000);
  });

  it('takes the declared window over a name-colliding catalogue hit on a custom endpoint', async () => {
    const resolved = await resolvesWith({
      providers: {
        relay: {
          preset: 'openai-compatible',
          apiKey: 'sk',
          baseUrl: 'https://relay.example/v1',
          modelContextWindows: { 'gpt-5.6': 400_000 },
        },
      },
      slots: { 'course.content': 'relay:gpt-5.6' },
    });
    expect(resolved.modelInfo).toMatchObject({ contextWindow: 400_000, outputWindow: 128_000 });
  });

  it('fills a declared window when the catalogue row exists but omits it', async () => {
    // Lemonade's Gemma row has streaming/tools/vision but no contextWindow.
    // Override the baseUrl to a non-local address so the SSRF guard passes in tests.
    const resolved = await resolvesWith({
      providers: {
        lm: {
          preset: 'lemonade',
          apiKey: '',
          baseUrl: 'https://lemonade.example/v1',
          modelContextWindows: { 'Gemma-4-26B-A4B-it-GGUF': 200_000 },
        },
      },
      slots: { 'course.content': 'lm:Gemma-4-26B-A4B-it-GGUF' },
    });
    expect(resolved.modelInfo?.contextWindow).toBe(200_000);
    // The catalogue's own name and capabilities are kept.
    expect(resolved.modelInfo?.name).toBe('Gemma 4 26B A4B IT GGUF');
  });

  it('uses declared vision: true for a catalogue-less custom model', async () => {
    const resolved = await resolvesWith({
      providers: {
        relay: {
          preset: 'openai-compatible',
          apiKey: 'sk',
          baseUrl: 'https://relay.example/v1',
          models: ['custom-vlm'],
          modelVision: { 'custom-vlm': true },
        },
      },
      slots: { 'course.content': 'relay:custom-vlm' },
    });
    expect(resolved.modelInfo).toEqual({
      id: 'custom-vlm',
      name: 'custom-vlm',
      capabilities: { vision: true },
    });
  });

  it('combines declared contextWindow and declared vision on a catalogue-less model', async () => {
    const resolved = await resolvesWith({
      providers: {
        relay: {
          preset: 'openai-compatible',
          apiKey: 'sk',
          baseUrl: 'https://relay.example/v1',
          models: ['custom-vlm'],
          modelContextWindows: { 'custom-vlm': 512_000 },
          modelVision: { 'custom-vlm': true },
        },
      },
      slots: { 'course.content': 'relay:custom-vlm' },
    });
    expect(resolved.modelInfo).toEqual({
      id: 'custom-vlm',
      name: 'custom-vlm',
      contextWindow: 512_000,
      capabilities: { vision: true },
    });
  });

  it('ignores declared vision when the built-in catalogue says vision: false', async () => {
    const resolved = await resolvesWith({
      providers: {
        ac: {
          preset: 'atlascloud',
          apiKey: 'sk-test',
          models: ['deepseek-ai/deepseek-v4-pro'],
          modelVision: { 'deepseek-ai/deepseek-v4-pro': true },
        },
      },
      slots: { 'course.content': 'ac:deepseek-ai/deepseek-v4-pro' },
    });
    expect(resolved.modelInfo?.capabilities?.vision).toBe(false);
  });

  it('takes declared vision over a name-colliding catalogue hit on a custom endpoint', async () => {
    const resolved = await resolvesWith({
      providers: {
        relay: {
          preset: 'openai-compatible',
          apiKey: 'sk',
          baseUrl: 'https://relay.example/v1',
          modelVision: { 'gpt-5.6': false },
        },
      },
      slots: { 'course.content': 'relay:gpt-5.6' },
    });
    expect(resolved.modelInfo?.capabilities?.vision).toBe(false);
  });

  it('forwards render_scene_preview images only when vision is enabled or known by the catalogue (#2111)', async () => {
    const { toModelMessages } = await import('@/lib/agent/runtime/stream-fn');
    const previewToolResult = {
      role: 'toolResult' as const,
      toolCallId: 'call-preview-1',
      toolName: 'render_scene_preview',
      content: [
        { type: 'text' as const, text: 'Rendered scene 1 preview.' },
        { type: 'image' as const, data: 'ZmFrZS1wbmc=', mimeType: 'image/png' },
      ],
      isError: false,
      timestamp: Date.now(),
    };

    const withVision = await resolvesWith({
      providers: {
        relay: {
          preset: 'openai-compatible',
          apiKey: 'sk',
          baseUrl: 'https://relay.example/v1',
          models: ['custom-vlm'],
          modelVision: { 'custom-vlm': true },
        },
      },
      slots: { 'course.content': 'relay:custom-vlm' },
    });
    const forwarded = toModelMessages([previewToolResult], {
      includeToolImages: withVision.modelInfo?.capabilities?.vision,
    });
    expect(forwarded).toHaveLength(2);
    expect(forwarded[1]).toMatchObject({
      role: 'user',
      content: expect.arrayContaining([
        { type: 'image', image: 'ZmFrZS1wbmc=', mediaType: 'image/png' },
      ]),
    });

    const withoutVision = await resolvesWith({
      providers: {
        relay: {
          preset: 'openai-compatible',
          apiKey: 'sk',
          baseUrl: 'https://relay.example/v1',
          models: ['custom-text'],
        },
      },
      slots: { 'course.content': 'relay:custom-text' },
    });
    const omitted = toModelMessages([previewToolResult], {
      includeToolImages: withoutVision.modelInfo?.capabilities?.vision,
    });
    expect(omitted).toHaveLength(1);
    expect(JSON.stringify(omitted[0])).toContain(
      'Image observation omitted: the selected model does not support image input.',
    );

    const catalogueFalse = await resolvesWith({
      providers: {
        ac: {
          preset: 'atlascloud',
          apiKey: 'sk-test',
          models: ['deepseek-ai/deepseek-v4-pro'],
          modelVision: { 'deepseek-ai/deepseek-v4-pro': true },
        },
      },
      slots: { 'course.content': 'ac:deepseek-ai/deepseek-v4-pro' },
    });
    const ignoredFlag = toModelMessages([previewToolResult], {
      includeToolImages: catalogueFalse.modelInfo?.capabilities?.vision,
    });
    expect(ignoredFlag).toHaveLength(1);
    expect(JSON.stringify(ignoredFlag[0])).toContain(
      'Image observation omitted: the selected model does not support image input.',
    );
  });
});
