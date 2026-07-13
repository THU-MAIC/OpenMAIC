import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(async (params: unknown) => ({
    text: 'ok',
    params,
    usage: undefined as unknown,
  })),
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
});
