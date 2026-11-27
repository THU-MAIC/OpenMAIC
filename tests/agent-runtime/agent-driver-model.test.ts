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
  plan: { preset: 'chatgpt-plan' },
  openai: { preset: 'openai', apiKey: 'sk', models: ['gpt-5.6-luna'] },
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

  it('follows the default model a user chose, on a deployment configured through DEFAULT_MODEL', async () => {
    const resolve = await configure(undefined, {
      defaults: { llm: 'openai:gpt-5.6', agent: null },
      workspace: { source: 'workspace', config: { slots: { llm: 'openai:gpt-5.6-luna' } } },
    });
    const resolved = await resolve('user:alice');
    expect(resolved.piModel).toMatchObject({ id: 'gpt-5.6-luna', provider: 'openai' });
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

  it('uses the full plan model window for teaching when a paid fallback is configured', async () => {
    const resolve = await configure({
      model: 'plan:plan-model',
      fallback: 'openai:unknown-window',
    });
    mocks.modelInfo = { contextWindow: 800_000, outputWindow: 32_000 };
    const driver = await resolve();
    expect(driver.teaching.piModel.contextWindow).toBe(800_000);
    expect(driver.teaching.wireMaxOutputTokens).toBe(32_000);
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

  it('sends the per-call summary cap for an unknown model when the stream is not uncapped', async () => {
    // The runner's compaction summary stream: same connection, no catalog
    // output window, but it must honor pi's explicit summary maxTokens.
    mocks.streamLLM.mockReturnValue(finishedStream());
    const { createCallLlmStreamFn } = await import('@/lib/agent/runtime/stream-fn');
    const streamFn = createCallLlmStreamFn({
      languageModel: {} as never,
      maxOutputTokens: undefined,
    });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'system', messages: [], tools: [] },
      { maxTokens: 2_560 },
    );
    await drain(stream);

    expect(mocks.streamLLM.mock.calls[0]?.[0]?.maxOutputTokens).toBe(2_560);
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

  it('halves an output reservation that would consume the whole context window', async () => {
    mocks.modelInfo = { contextWindow: 1_050_000, outputWindow: 128_000 };
    const resolved = await (
      await configure({ model: 'openai:gpt-5.6-luna', contextWindow: 32_000 })
    )();
    // Conversation, summary and the budget check all see the same reservation.
    expect(resolved.reservedOutputTokens).toBe(16_000);
    expect(resolved.wireMaxOutputTokens).toBe(16_000);
    expect(resolved.piModel.maxTokens).toBe(16_000);
  });

  it('keeps an output reservation that fits inside the context window', async () => {
    mocks.modelInfo = { contextWindow: 200_000, outputWindow: 128_000 };
    const resolved = await (await configure({ model: 'openai:gpt-5.6-luna' }))();
    expect(resolved.reservedOutputTokens).toBe(128_000);
    expect(resolved.wireMaxOutputTokens).toBe(128_000);
  });

  it.each([
    [64_000, 8192, 64_000, 8192],
    [undefined, undefined, 128_000, undefined],
    [0, Number.NaN, 128_000, undefined],
    [400_000, 32_768, 200_000, 16_384],
  ])(
    'budgets teaching for both slot targets (fallback context %s, output %s)',
    async (contextWindow, outputWindow, expectedContext, expectedOutput) => {
      const providers = await import('@/lib/ai/providers');
      const original = providers.getModelInfo;
      const spy = vi
        .spyOn(providers, 'getModelInfo')
        .mockImplementation((provider, id) =>
          id === 'gpt-4.1'
            ? ({ id, name: id, contextWindow, outputWindow } as never)
            : original(provider, id),
        );
      try {
        const resolved = await (
          await configure({ model: 'openai:gpt-5.6-luna', fallback: 'openai:gpt-4.1' })
        )();
        expect(resolved.teaching.piModel.contextWindow).toBe(expectedContext);
        expect(resolved.teaching.wireMaxOutputTokens).toBe(expectedOutput);
        // Ordinary Agent calls retain the original primary metadata and transport.
        expect(resolved.piModel.contextWindow).toBe(200_000);
        expect(resolved.wireMaxOutputTokens).toBe(16_384);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('does not reserve for a fallback the slot cannot use', async () => {
    const resolved = await (
      await configure({ model: 'openai:gpt-5.6-luna', fallback: 'ac:qwen/qwen3.5-flash' })
    )();
    expect(resolved.teaching.piModel).toEqual(resolved.piModel);
    expect(resolved.teaching.wireMaxOutputTokens).toBe(16_384);
  });

  it('does not infer a known wire cap when only the fallback output is known', async () => {
    mocks.modelInfo = null;
    const resolved = await (
      await configure({ model: 'openai:some-model', fallback: 'openai:gpt-4.1' })
    )();
    expect(resolved.teaching.wireMaxOutputTokens).toBeUndefined();
    expect(resolved.wireMaxOutputTokens).toBeUndefined();
  });

  it('plans teaching with a context window declared for the fallback', async () => {
    const resolved = await (
      await configure(undefined, {
        workspace: {
          source: 'workspace',
          config: {
            providers: {
              relay: {
                preset: 'openai-compatible',
                apiKey: 'sk',
                modelContextWindows: { m2: 50_000 },
              },
            },
            slots: { agent: { model: 'relay:m1', fallback: 'relay:m2' } },
          },
        },
      })
    )('user:alice');
    expect(resolved.piModel.contextWindow).toBe(200_000);
    // The fallback sits on an endpoint the catalogue does not describe: its
    // declared window, not the 128k estimate, caps the shared teaching budget.
    expect(resolved.teaching.piModel.contextWindow).toBe(50_000);
  });

  it('keeps the 128k planning estimate for a fallback without a declaration', async () => {
    const resolved = await (
      await configure(undefined, {
        workspace: {
          source: 'workspace',
          config: {
            providers: { relay: { preset: 'openai-compatible', apiKey: 'sk' } },
            slots: { agent: { model: 'relay:m1', fallback: 'relay:m2' } },
          },
        },
      })
    )('user:alice');
    expect(resolved.piModel.contextWindow).toBe(200_000);
    expect(resolved.teaching.piModel.contextWindow).toBe(128_000);
  });
});
