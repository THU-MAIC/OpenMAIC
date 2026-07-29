import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));

import { createCallLlmStreamFn } from '@/lib/agent/runtime/stream-fn';

describe('createCallLlmStreamFn usage', () => {
  beforeEach(() => mocks.streamLLM.mockReset());

  it('writes AI SDK token usage into the completed Pi assistant message', async () => {
    mocks.streamLLM.mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'answer' };
      })(),
      usage: Promise.resolve({
        inputTokens: 120,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 },
      }),
    });
    const streamFn = createCallLlmStreamFn({ languageModel: {} as never });

    const stream = await streamFn(
      {} as never,
      { systemPrompt: 'test', messages: [], tools: [] },
      {},
    );
    const message = await stream.result();

    expect(message.usage).toMatchObject({
      input: 105,
      output: 30,
      cacheRead: 10,
      cacheWrite: 5,
      totalTokens: 150,
    });
  });
});
