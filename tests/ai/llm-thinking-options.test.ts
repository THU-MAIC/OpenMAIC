import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMock = vi.hoisted(() => ({
  // `totalUsage` is optional here so a single-step case can omit it: multi-step
  // runs report the aggregate there and callLLM prefers it over `usage`.
  generateText: vi.fn(
    async (
      params: unknown,
    ): Promise<{ text: string; params: unknown; usage?: unknown; totalUsage?: unknown }> => ({
      text: 'ok',
      params,
    }),
  ),
  streamText: vi.fn(),
}));

const usageMock = vi.hoisted(() => ({
  normalizeUsage: vi.fn((usage: unknown) => usage),
  recordUsage: vi.fn(async () => undefined),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));

vi.mock('@/lib/usage/normalize', () => ({
  normalizeUsage: usageMock.normalizeUsage,
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordUsage: usageMock.recordUsage,
}));

import { callLLM } from '@/lib/ai/llm';

describe('LLM thinking provider options', () => {
  beforeEach(() => {
    aiMock.generateText.mockClear();
    usageMock.normalizeUsage.mockClear();
    usageMock.recordUsage.mockClear();
  });

  it('sends GPT-5.6 max reasoning effort through OpenAI provider options', async () => {
    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', effort: 'max' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          openai: {
            reasoningEffort: 'max',
          },
        },
      }),
    );
  });

  it('sends max reasoning effort for the GPT-5.6 Sol model ID alias', async () => {
    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6-sol',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', effort: 'max' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ modelId: 'gpt-5.6-sol' }),
        providerOptions: {
          openai: {
            reasoningEffort: 'max',
          },
        },
      }),
    );
  });

  it('aggregates GPT-5.6 Sol alias usage under the canonical model ID', async () => {
    aiMock.generateText.mockResolvedValueOnce({
      text: 'ok',
      params: undefined,
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6-sol',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: 'openai',
          modelId: 'gpt-5.6',
          modelString: 'openai:gpt-5.6',
        }),
      );
    });
  });

  it('records the aggregate usage of a multi-step tool run, not the last step', async () => {
    // `usage` on a multi-step run (`stopWhen`) is the final step alone; every
    // earlier step's tokens live only in `totalUsage`.
    aiMock.generateText.mockResolvedValueOnce({
      text: 'ok',
      params: undefined,
      usage: { inputTokens: 3, outputTokens: 4 },
      totalUsage: { inputTokens: 30, outputTokens: 40 },
    });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ usage: { inputTokens: 30, outputTokens: 40 } }),
      );
    });
  });

  it('records every attempt when a retry is configured, not just the accepted one', async () => {
    // Both attempts hit the provider and were billed; the first one just failed
    // validation. Recording on the success path only would drop it.
    aiMock.generateText
      .mockResolvedValueOnce({
        text: '',
        params: undefined,
        totalUsage: { inputTokens: 7, outputTokens: 0 },
      })
      .mockResolvedValueOnce({
        text: 'ok',
        params: undefined,
        totalUsage: { inputTokens: 9, outputTokens: 2 },
      });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      { retries: 1 },
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledTimes(2);
    });
    // Nested objectContaining: the recorded usage may carry normalised
    // zero-valued fields alongside the two this test set.
    expect(usageMock.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 7, outputTokens: 0 }),
      }),
    );
    expect(usageMock.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ inputTokens: 9, outputTokens: 2 }),
      }),
    );
  });

  it('records the last attempt even when every attempt fails validation', async () => {
    // `Once` twice rather than a persistent implementation: beforeEach only
    // clears calls, so a lingering mockResolvedValue would leak into later tests.
    const failed = {
      text: '',
      params: undefined,
      totalUsage: { inputTokens: 5, outputTokens: 0 },
    };
    aiMock.generateText.mockResolvedValueOnce(failed).mockResolvedValueOnce(failed);

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      { retries: 1 },
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledTimes(2);
    });
  });

  // Defensive: ai@6's GenerateTextResult always carries `totalUsage`, so this
  // shape is not one the current SDK produces — the fallback exists so a future
  // result shape without the aggregate degrades to the final step instead of
  // recording nothing.
  it('falls back to the single-step usage when no aggregate is reported', async () => {
    aiMock.generateText.mockResolvedValueOnce({
      text: 'ok',
      params: undefined,
      usage: { inputTokens: 3, outputTokens: 4 },
    });

    await callLLM(
      {
        model: {
          provider: 'openai.responses',
          modelId: 'gpt-5.6',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
    );

    await vi.waitFor(() => {
      expect(usageMock.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ usage: { inputTokens: 3, outputTokens: 4 } }),
      );
    });
  });

  it('sends Claude Haiku 4.5 thinking budget without effort', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'claude-haiku-4-5',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', budgetTokens: 4096 },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'enabled', budgetTokens: 4096 },
          },
        },
      }),
    );
    const params = aiMock.generateText.mock.calls[0]?.[0] as {
      providerOptions?: { anthropic?: Record<string, unknown> };
    };
    expect(params.providerOptions?.anthropic).not.toHaveProperty('effort');
  });

  it('sends MiniMax M3 thinking disablement through Anthropic provider options', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'MiniMax-M3',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'disabled' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'disabled' },
          },
        },
      }),
    );
  });

  it('coerces disabled thinking to the lowest supported effort for Claude Fable 5', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'claude-fable-5',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'disabled' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'adaptive' },
            effort: 'low',
          },
        },
      }),
    );
  });

  it('sends xhigh reasoning effort for Claude 5 models', async () => {
    await callLLM(
      {
        model: {
          provider: 'anthropic.messages',
          modelId: 'claude-opus-5',
        },
        prompt: 'hi',
      } as Parameters<typeof callLLM>[0],
      'test',
      undefined,
      { mode: 'enabled', effort: 'xhigh' },
    );

    expect(aiMock.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: 'adaptive' },
            effort: 'xhigh',
          },
        },
      }),
    );
  });
});
