import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelConfigLayer } from '@/lib/server/model-config/resolve-slot';

const mocks = vi.hoisted(() => ({
  streamLLM: vi.fn(),
  modelInfo: undefined as unknown,
  workspaceReads: [] as string[],
}));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
// The connection itself is lib/server/model-config/llm.ts's business; here it
// only echoes the resolution, with the catalogue info a case sets.
vi.mock('@/lib/server/model-config/llm', () => ({
  slotLanguageModel: async (resolution: {
    registryId: string;
    modelId: string;
    baseUrl?: string;
    thinking?: unknown;
  }) => ({
    model: {},
    modelInfo: mocks.modelInfo,
    modelString: `${resolution.registryId}:${resolution.modelId}`,
    providerId: resolution.registryId,
    modelId: resolution.modelId,
    apiKey: 'secret',
    baseUrl: resolution.baseUrl,
    thinkingConfig: resolution.thinking,
    serverManaged: true,
    resolution,
  }),
}));

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
};

function finishedStream() {
  return {
    fullStream: (async function* () {
      yield { type: 'finish', finishReason: 'stop', totalUsage: ZERO_USAGE };
    })(),
    usage: Promise.resolve(ZERO_USAGE),
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Drain the protocol stream so the async transport call settles.
  }
}

const providers = {
  openai: { preset: 'openai', apiKey: 'sk' },
  ac: { preset: 'atlascloud', apiKey: 'sk' },
};

async function configure(
  agent: unknown,
  {
    workspace,
    defaults,
  }: { workspace?: ModelConfigLayer; defaults?: ModelConfigLayer['config']['slots'] } = {},
) {
  const runtime = await import('@/lib/server/model-config/runtime');
  const slots = agent === undefined ? { ...defaults } : { ...defaults, agent };
  runtime.setDeploymentConfigForTests({
    layer: { source: 'deployment', config: { providers, slots } as ModelConfigLayer['config'] },
    legacy: !!defaults,
    notices: [],
  });
  runtime.setWorkspaceLayerLoaderForTests(async (ownerId) => {
    mocks.workspaceReads.push(ownerId);
    return workspace ?? null;
  });
  return (await import('@/lib/server/agent-runtime/agent-driver-model')).resolveAgentDriverModel;
}

describe('agent driver model', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.streamLLM.mockReset();
    mocks.modelInfo = { contextWindow: 200_000, outputWindow: 16_384 };
    mocks.workspaceReads.length = 0;
  });

  afterEach(async () => {
    const runtime = await import('@/lib/server/model-config/runtime');
    runtime.setDeploymentConfigForTests();
    runtime.setWorkspaceLayerLoaderForTests();
  });

  it('fails loud when nothing assigns the agent', async () => {
    const resolve = await configure(undefined);
    await expect(resolve()).rejects.toThrow('No model is configured for agent');
  });

  it('stays off where an older deployment had no driver route', async () => {
    const resolve = await configure(undefined, {
      defaults: { llm: 'openai:gpt-5.6', agent: null },
    });
    await expect(resolve()).rejects.toThrow('agent capability is turned off');
  });

  it("uses the owner's workspace model", async () => {
    const resolve = await configure(undefined, {
      workspace: { source: 'workspace', config: { slots: { llm: 'openai:gpt-5.6-luna' } } },
    });
    const resolved = await resolve('user:alice');
    expect(mocks.workspaceReads).toEqual(['user:alice']);
    expect(resolved.piModel).toMatchObject({ id: 'gpt-5.6-luna', provider: 'openai' });
  });

  it('fails loud when reasoning effort is configured for the tool-using driver', async () => {
    const resolve = await configure({
      model: 'openai:gpt-5.6-luna',
      thinking: { effort: 'medium' },
    });
    await expect(resolve()).rejects.toThrow('must not set thinking.effort');
  });

  it('drops the effort the agent inherits from the default model and keeps the rest', async () => {
    // The home toolbar writes a thinking level on llm; the agent follows llm.
    const resolve = await configure(undefined, {
      workspace: {
        source: 'workspace',
        config: {
          slots: {
            llm: { model: 'openai:gpt-5.6-luna', thinking: { mode: 'enabled', effort: 'high' } },
          },
        },
      },
    });
    const resolved = await resolve('user:alice');
    expect(resolved.piModel).toMatchObject({ id: 'gpt-5.6-luna', provider: 'openai' });
    expect(resolved.connection.thinkingConfig).toEqual({ mode: 'enabled' });
  });

  it('keeps an inherited "no thinking" as thinking off rather than the model default', async () => {
    const resolve = await configure(undefined, {
      workspace: {
        source: 'workspace',
        config: { slots: { llm: { model: 'openai:gpt-5.6-luna', thinking: { effort: 'none' } } } },
      },
    });
    expect((await resolve('user:alice')).connection.thinkingConfig).toEqual({ mode: 'disabled' });
  });

  it('refuses a model the catalogue says cannot call tools', async () => {
    const resolve = await configure('ac:qwen/qwen3.5-flash');
    await expect(resolve()).rejects.toThrow('does not support tool calling');
  });

  it('defaults the pi API dialect and passes an explicit one through', async () => {
    let resolve = await configure('openai:gpt-5.6-luna');
    expect((await resolve()).piModel).toMatchObject({
      id: 'gpt-5.6-luna',
      provider: 'openai',
      api: 'openai-completions',
    });
    vi.resetModules();
    resolve = await configure({ model: 'openai:gpt-5.6-luna', api: 'openai-responses' });
    expect((await resolve()).piModel.api).toBe('openai-responses');
  });

  it('fails loud for an incompatible pi API dialect', async () => {
    const resolve = await configure({ model: 'openai:gpt-5.6-luna', api: 'anthropic-messages' });
    await expect(resolve()).rejects.toThrow('unsupported pi api/dialect');
  });

  it('uses the provider catalog window when the model is known', async () => {
    const resolved = await (await configure('openai:gpt-5.6-luna'))();
    expect(resolved.piModel.contextWindow).toBe(200_000);
    expect(resolved.piModel.maxTokens).toBe(16_384);
    expect(resolved.wireMaxOutputTokens).toBe(16_384);
    expect(resolved.reservedOutputTokens).toBe(16_384);
  });

  it('falls back to a conservative real window for an unknown model', async () => {
    mocks.modelInfo = null;
    const resolved = await (await configure('openai:some-model'))();
    // The old 1_050_000 fallback made pi's compaction threshold unreachable;
    // the calibrated fallback is a conservative real window.
    expect(resolved.piModel.contextWindow).toBe(128_000);
    expect(resolved.piModel.maxTokens).toBe(8_192);
    expect(resolved.wireMaxOutputTokens).toBeUndefined();
    expect(resolved.reservedOutputTokens).toBe(8_192);
  });

  it('omits the unknown-model output limit even when compaction supplies its reservation', async () => {
    mocks.streamLLM.mockReturnValue(finishedStream());
    const { createCallLlmStreamFn } = await import('@/lib/agent/runtime/stream-fn');
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      maxOutputTokens: undefined,
      omitMaxOutputTokens: true,
    });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'system', messages: [], tools: [] },
      { maxTokens: 8_192 },
    );
    await drain(stream);

    expect(mocks.streamLLM.mock.calls[0]?.[0]?.maxOutputTokens).toBeUndefined();
  });

  it('keeps the catalog output limit on the wire for a known model', async () => {
    mocks.streamLLM.mockReturnValue(finishedStream());
    const { createCallLlmStreamFn } = await import('@/lib/agent/runtime/stream-fn');
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      maxOutputTokens: 16_384,
    });

    const stream = await streamFn({} as never, { systemPrompt: 'system', messages: [], tools: [] });
    await drain(stream);

    expect(mocks.streamLLM.mock.calls[0]?.[0]?.maxOutputTokens).toBe(16_384);
  });

  it('lets the slot pin a contextWindow below the catalog value', async () => {
    mocks.modelInfo = { contextWindow: 1_050_000, outputWindow: 128_000 };
    const resolved = await (
      await configure({ model: 'openai:gpt-5.6-luna', contextWindow: 32_000 })
    )();
    expect(resolved.piModel.contextWindow).toBe(32_000);
  });
});
