import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { getModel } from '@/lib/ai/providers';

describe('OpenAI SDK integration', () => {
  it('accepts GPT-5.6 max reasoning effort and sends it to the Responses API', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchMock = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: 'resp_test',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5.6',
          output: [
            {
              id: 'msg_test',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const openai = createOpenAI({ apiKey: 'sk-test', fetch: fetchMock });

    const result = await generateText({
      model: openai.responses('gpt-5.6'),
      prompt: 'hi',
      providerOptions: { openai: { reasoningEffort: 'max' } },
    });

    expect(result.text).toBe('ok');
    expect(requestBody).toMatchObject({
      model: 'gpt-5.6',
      reasoning: { effort: 'max' },
    });
  });

  it('propagates SSE error frames through streaming Chat compatibility', async () => {
    vi.stubEnv('OPENAI_COMPAT_USE_STREAMING_CHAT', 'true');
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response('data: {"error":{"message":"quota exceeded"}}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const { model } = getModel({
        providerId: 'openai',
        modelId: 'gpt-5.6-sol',
        apiKey: 'sk-test',
        baseUrl: 'https://relay.example/v1',
      });

      await expect(
        generateText({
          model,
          prompt: 'hi',
          maxRetries: 0,
        }),
      ).rejects.toMatchObject({
        name: 'AI_APICallError',
        message: 'quota exceeded',
        statusCode: 500,
        isRetryable: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
      vi.unstubAllEnvs();
    }
  });
});
