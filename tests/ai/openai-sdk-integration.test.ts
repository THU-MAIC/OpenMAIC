import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveThinkingProviderOptions } from '@/lib/ai/llm';
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

  it('preserves compatible provider identity for direct thinking option resolution', () => {
    const { model } = getModel({
      providerId: 'kimi',
      modelId: 'kimi-k3',
      apiKey: 'sk-test',
    });

    expect((model as { provider: string }).provider).toBe('kimi.chat');
    expect(
      resolveThinkingProviderOptions(model, {
        mode: 'enabled',
        effort: 'high',
      }),
    ).toEqual({
      openai: {
        reasoningEffort: 'high',
      },
    });
  });

  it('preserves Kimi K3 reasoning_content across automatic tool continuations', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const firstStep = requestBodies.length === 1;
      const chunks = firstStep
        ? [
            {
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: 'use the lookup tool' },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-1',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ]
        : [
            {
              id: 'chatcmpl-2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
            },
            {
              id: 'chatcmpl-2',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'kimi-k3',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ];
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch;

    try {
      const { model } = getModel({
        providerId: 'kimi',
        modelId: 'kimi-k3',
        apiKey: 'sk-test',
      });
      const result = streamText({
        model,
        prompt: 'find it',
        tools: {
          lookup: tool({
            description: 'lookup',
            inputSchema: z.object({}),
            execute: async () => ({ found: true }),
          }),
        },
        stopWhen: stepCountIs(2),
      });

      await result.consumeStream();

      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toMatchObject({
        messages: [
          { role: 'user', content: 'find it' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: 'use the lookup tool',
            tool_calls: [{ id: 'call-1' }],
          },
          { role: 'tool', tool_call_id: 'call-1' },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
