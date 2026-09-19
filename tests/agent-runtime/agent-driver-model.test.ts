import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveModel: vi.fn(), streamLLM: vi.fn() }));

vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

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

describe('agent driver model route', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resolveModel.mockReset();
    mocks.streamLLM.mockReset();
    delete process.env.MODEL_ROUTES;
  });

  it('fails loud when the dedicated route is missing', async () => {
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    await expect(resolveAgentDriverModel()).rejects.toThrow('must explicitly configure');
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it('fails loud when reasoning effort is configured for the tool-using driver', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'openai:gpt-5.6-luna',
        thinking: { effort: 'medium' },
        api: 'openai-completions',
      },
    });
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    await expect(resolveAgentDriverModel()).rejects.toThrow('must not set thinking.effort');
  });

  it('requires an explicit provider prefix', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'gpt-5.6-luna',
        api: 'openai-completions',
      },
    });
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    await expect(resolveAgentDriverModel()).rejects.toThrow('explicit provider prefix');
    expect(mocks.resolveModel).not.toHaveBeenCalled();
  });

  it.each(['gpt-5.6-terra', 'gpt-5.6-luna'])(
    'accepts configured driver model %s and passes the explicit pi API dialect',
    async (modelId) => {
      process.env.MODEL_ROUTES = JSON.stringify({
        'maic-agent-driver': {
          model: `openai:${modelId}`,
          api: 'openai-completions',
        },
      });
      mocks.resolveModel.mockResolvedValue({
        model: {},
        modelInfo: { contextWindow: 1_050_000, outputWindow: 128_000 },
        modelString: `openai:${modelId}`,
        providerId: 'openai',
        modelId,
        apiKey: 'secret',
        baseUrl: 'https://gateway.example/v1',
        thinkingConfig: undefined,
      });
      const { resolveAgentDriverModel } =
        await import('@/lib/server/agent-runtime/agent-driver-model');
      const resolved = await resolveAgentDriverModel();

      expect(mocks.resolveModel).toHaveBeenCalledWith({ stage: 'maic-agent-driver' });
      expect(resolved.piModel).toMatchObject({
        id: modelId,
        provider: 'openai',
        api: 'openai-completions',
      });
    },
  );

  it('uses the provider catalog window when the model is known', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': { model: 'openai:gpt-5.6-luna', api: 'openai-completions' },
    });
    mocks.resolveModel.mockResolvedValue({
      model: {},
      modelInfo: { contextWindow: 200_000, outputWindow: 16_384 },
      modelString: 'openai:gpt-5.6-luna',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      thinkingConfig: undefined,
    });
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    const resolved = await resolveAgentDriverModel();

    expect(resolved.piModel.contextWindow).toBe(200_000);
    expect(resolved.piModel.maxTokens).toBe(16_384);
    expect(resolved.wireMaxOutputTokens).toBe(16_384);
    expect(resolved.reservedOutputTokens).toBe(16_384);
  });

  it('falls back to a conservative real window for an unknown model', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': { model: 'custom:some-model', api: 'openai-completions' },
    });
    mocks.resolveModel.mockResolvedValue({
      model: {},
      modelInfo: null,
      modelString: 'custom:some-model',
      providerId: 'custom',
      modelId: 'some-model',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      thinkingConfig: undefined,
    });
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    const resolved = await resolveAgentDriverModel();

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

  it('lets the route pin a contextWindow below the catalog value', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'openai:gpt-5.6-luna',
        api: 'openai-completions',
        contextWindow: 32_000,
      },
    });
    mocks.resolveModel.mockResolvedValue({
      model: {},
      modelInfo: { contextWindow: 1_050_000, outputWindow: 128_000 },
      modelString: 'openai:gpt-5.6-luna',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      thinkingConfig: undefined,
    });
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    const resolved = await resolveAgentDriverModel();

    expect(resolved.piModel.contextWindow).toBe(32_000);
  });

  it('propagates an unresolvable provider failure', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'custom:gpt-5.6-luna',
        api: 'openai-completions',
      },
    });
    mocks.resolveModel.mockRejectedValue(new Error('Unknown provider: custom'));
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    await expect(resolveAgentDriverModel()).rejects.toThrow('Unknown provider: custom');
  });

  it('fails loud for an incompatible pi API dialect', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'openai:gpt-5.6-luna',
        api: 'anthropic-messages',
      },
    });
    mocks.resolveModel.mockResolvedValue({
      model: {},
      modelInfo: {},
      modelString: 'openai:gpt-5.6-luna',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      thinkingConfig: { effort: 'medium' },
    });
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    await expect(resolveAgentDriverModel()).rejects.toThrow('unsupported pi api/dialect');
  });

  it('fails loud when api/dialect is omitted', async () => {
    process.env.MODEL_ROUTES = JSON.stringify({
      'maic-agent-driver': {
        model: 'openai:gpt-5.6-luna',
      },
    });
    mocks.resolveModel.mockResolvedValue({
      model: {},
      modelInfo: {},
      modelString: 'openai:gpt-5.6-luna',
      providerId: 'openai',
      modelId: 'gpt-5.6-luna',
      apiKey: 'secret',
      baseUrl: 'https://gateway.example/v1',
      thinkingConfig: undefined,
    });
    const { resolveAgentDriverModel } =
      await import('@/lib/server/agent-runtime/agent-driver-model');
    await expect(resolveAgentDriverModel()).rejects.toThrow('unsupported pi api/dialect');
  });
});
