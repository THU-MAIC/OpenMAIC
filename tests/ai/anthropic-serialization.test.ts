import { createAnthropic } from '@ai-sdk/anthropic';
import { describe, expect, it, vi } from 'vitest';

import { callLLM } from '@/lib/ai/llm';

describe('Anthropic request serialization', () => {
  it('serializes Claude Haiku 4.5 thinking budget without effort', async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          type: 'message',
          id: 'msg_test',
          model: 'claude-haiku-4-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: fetchMock,
    });

    await callLLM(
      {
        model: anthropic.chat('claude-haiku-4-5'),
        prompt: 'hi',
        maxOutputTokens: 10,
      } as Parameters<typeof callLLM>[0],
      'serialization-test',
      undefined,
      { mode: 'enabled', budgetTokens: 4096 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(captured).toMatchObject({
      model: 'claude-haiku-4-5',
      max_tokens: 4106,
      thinking: {
        type: 'enabled',
        budget_tokens: 4096,
      },
    });
    expect(captured?.output_config).toBeUndefined();
  });
});
