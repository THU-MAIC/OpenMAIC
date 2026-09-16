import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { resolveThinkingProviderOptions, streamLLM } from '@/lib/ai/llm';
import { getModel, preservesReasoningForModel } from '@/lib/ai/providers';

describe('OpenAI SDK integration', () => {
  it('carries the custom gateway toggle in and reasoning_content back out', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const chunks = [
        {
          id: 'chatcmpl-thinking',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash-vision-exp',
          choices: [
            {
              index: 0,
              delta: { reasoning_content: 'Inspect the evidence' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chatcmpl-thinking',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash-vision-exp',
          choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-thinking',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'deepseek-v4-flash-vision-exp',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof globalThis.fetch;

    try {
      const { model } = getModel({
        providerId: 'openai',
        modelId: 'deepseek-v4-flash-vision-exp',
        apiKey: 'sk-test',
        baseUrl: 'https://gateway.example/v1',
      });
      const result = streamLLM(
        { model, prompt: 'hi', maxRetries: 0 },
        'agent-runtime-thinking-seam',
        { enabled: true },
      );
      const parts: Array<Record<string, unknown>> = [];
      for await (const part of result.fullStream) parts.push(part as Record<string, unknown>);

      expect(requestBody).toMatchObject({
        chat_template_kwargs: { thinking: true },
      });
      expect(parts).toContainEqual(
        expect.objectContaining({ type: 'reasoning-delta', text: 'Inspect the evidence' }),
      );
      expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Done' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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

  describe('DeepSeek reasoning round-trip', () => {
    function sseBody(chunks: unknown[]): Response {
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
    }

    function chatChunk(
      delta: Record<string, unknown>,
      finishReason: string | null = null,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        id: 'chatcmpl-deepseek',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4-pro',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      };
    }

    const toolCallChunk = (delta: Record<string, unknown>) => chatChunk(delta);

    async function runToolTurn(withReasoning: boolean, providerId: 'deepseek' | 'qwen') {
      const requestBodies: Array<Record<string, unknown>> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (requestBodies.length === 1) {
          return sseBody([
            ...(withReasoning ? [toolCallChunk({ reasoning_content: 'use the lookup tool' })] : []),
            toolCallChunk({
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{}' },
                },
              ],
            }),
            chatChunk({}, 'tool_calls', {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          ]);
        }
        return sseBody([
          chatChunk({ content: 'done' }),
          chatChunk({}, 'stop', {
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        ]);
      }) as typeof globalThis.fetch;

      try {
        const { model } = getModel(
          providerId === 'deepseek'
            ? { providerId: 'deepseek', modelId: 'deepseek-v4-pro', apiKey: 'sk-test' }
            : { providerId: 'qwen', modelId: 'qwen3-max', apiKey: 'sk-test' },
        );
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
        return requestBodies;
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    it('preserves DeepSeek reasoning_content across automatic tool continuations', async () => {
      const requestBodies = await runToolTurn(true, 'deepseek');

      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toMatchObject({
        thinking: { type: 'enabled' },
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
      expect(requestBodies[1]).not.toHaveProperty('reasoning_effort');
    });

    it('backfills an empty reasoning_content for a reasoning-less DeepSeek tool turn', async () => {
      const requestBodies = await runToolTurn(false, 'deepseek');

      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[1]).toMatchObject({
        thinking: { type: 'enabled' },
        messages: [
          { role: 'user', content: 'find it' },
          {
            role: 'assistant',
            content: null,
            reasoning_content: '',
            tool_calls: [{ id: 'call-1' }],
          },
          { role: 'tool', tool_call_id: 'call-1' },
        ],
      });
    });

    it('does not round-trip reasoning for a provider outside the preserving set', async () => {
      const requestBodies = await runToolTurn(true, 'qwen');

      expect(requestBodies).toHaveLength(2);
      const assistant = (requestBodies[1]?.messages as Array<Record<string, unknown>>)[1];
      expect(assistant?.reasoning_content).toBeUndefined();
    });

    it('scopes reasoning_effort to DeepSeek calls without tools', async () => {
      const bodies: Array<Record<string, unknown>> = [];
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return sseBody([
          chatChunk({ content: 'ok' }),
          chatChunk({}, 'stop', {
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        ]);
      }) as typeof globalThis.fetch;

      try {
        const { model } = getModel({
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          apiKey: 'sk-test',
        });
        const lookup = tool({
          description: 'lookup',
          inputSchema: z.object({}),
          execute: async () => ({ found: true }),
        });

        await streamLLM({ model, prompt: 'hi', maxRetries: 0 }, 'test', { enabled: true }).consumeStream();
        expect(bodies.at(-1)).toMatchObject({ thinking: { type: 'enabled' } });
        expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort');

        await streamLLM({ model, prompt: 'hi', maxRetries: 0 }, 'test', {
          mode: 'enabled',
          effort: 'max',
        }).consumeStream();
        expect(bodies.at(-1)).toMatchObject({
          thinking: { type: 'enabled' },
          reasoning_effort: 'max',
        });

        await streamLLM(
          { model, prompt: 'hi', maxRetries: 0, tools: { lookup }, stopWhen: stepCountIs(1) },
          'test',
          { mode: 'enabled', effort: 'max' },
        ).consumeStream();
        expect(bodies.at(-1)).toMatchObject({ thinking: { type: 'enabled' } });
        expect(bodies.at(-1)).not.toHaveProperty('reasoning_effort');

        await streamLLM({ model, prompt: 'hi', maxRetries: 0 }, 'test').consumeStream();
        expect(bodies.at(-1)).toMatchObject({
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('folds a non-streaming DeepSeek reasoning_content without leaking it into the text', async () => {
      let requestBody: Record<string, unknown> | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-json',
            object: 'chat.completion',
            created: 1,
            model: 'deepseek-v4-pro',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'answer',
                  reasoning_content: 'weigh the options',
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof globalThis.fetch;

      try {
        const { model } = getModel({
          providerId: 'deepseek',
          modelId: 'deepseek-v4-pro',
          apiKey: 'sk-test',
        });
        const result = await generateText({ model, prompt: 'hi', maxRetries: 0 });

        expect(requestBody).toMatchObject({ thinking: { type: 'enabled' } });
        expect(result.text).toBe('answer');
        expect(String(result.reasoningText ?? '')).toContain('weigh the options');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('derives reasoning preservation from the request adapter, not the provider id', () => {
      const { model: deepseekModel } = getModel({
        providerId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        apiKey: 'sk-test',
      });
      const { model: atlasDeepseekModel } = getModel({
        providerId: 'atlascloud',
        modelId: 'deepseek-ai/deepseek-v4-pro',
        apiKey: 'sk-test',
      });
      const { model: kimiK3Model } = getModel({
        providerId: 'kimi',
        modelId: 'kimi-k3',
        apiKey: 'sk-test',
      });
      const { model: kimiK26Model } = getModel({
        providerId: 'kimi',
        modelId: 'kimi-k2.6',
        apiKey: 'sk-test',
      });

      expect(preservesReasoningForModel(deepseekModel)).toBe(true);
      expect(preservesReasoningForModel(atlasDeepseekModel)).toBe(true);
      expect(preservesReasoningForModel(kimiK3Model)).toBe(true);
      expect(preservesReasoningForModel(kimiK26Model)).toBe(false);
    });
  });
});
