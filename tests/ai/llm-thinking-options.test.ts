import { describe, expect, it, vi } from 'vitest';

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(async (params: unknown) => ({ text: 'ok', params })),
  streamText: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));

import { callLLM } from '@/lib/ai/llm';

describe('LLM thinking provider options', () => {
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
});
