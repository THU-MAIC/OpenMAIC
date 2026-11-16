import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { getModel } from '@/lib/ai/providers';
import { hostSystemTailMessage, prefixSystemTailMiddleware } from '@/lib/ai/request-system-tail';

const history = [
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'Actual learner reply' }] },
];

describe('request-local system instruction compatibility', () => {
  it('only moves marked host instructions and does not change an ordinary prompt', async () => {
    const middleware = prefixSystemTailMiddleware();
    const transform = middleware.transformParams!;
    const original = { prompt: [{ role: 'system' as const, content: 'Fixed rules' }, ...history] };
    expect(await transform({ params: original } as never)).toBe(original);
    const params = {
      prompt: [...original.prompt, hostSystemTailMessage('INITIAL'), hostSystemTailMessage('LIVE')],
    };
    const before = JSON.stringify(params);
    const converted = await transform({ params } as never);
    expect(converted.prompt).toEqual([
      { role: 'system', content: 'Fixed rules\nINITIAL\nLIVE' },
      ...history,
    ]);
    expect(JSON.stringify(params)).toBe(before);
    expect(converted.prompt[1]).toBe(history[0]);
  });

  it.each(['anthropic', 'google', 'bedrock', 'openai'] as const)(
    'sends valid host instructions through the real %s adapter',
    async (providerType) => {
      let request:
        | {
            messages: { role: string; content?: unknown }[];
            system: unknown;
            contents: { role: string }[];
            systemInstruction: { parts: unknown[] };
          }
        | undefined;
      const model = getModel({
        providerId: `tail-test-${providerType}` as never,
        providerType,
        modelId:
          providerType === 'anthropic'
            ? 'claude-sonnet-4-5'
            : providerType === 'google'
              ? 'gemini-2.5-flash'
              : 'gpt-4o-mini',
        apiKey: 'synthetic-key',
        baseUrl: 'https://protocol-test.invalid/v1',
        fetchImpl: async (_url, init) => {
          request = JSON.parse(String(init?.body));
          const response =
            providerType === 'anthropic'
              ? {
                  id: 'msg_test',
                  type: 'message',
                  role: 'assistant',
                  model: 'claude-sonnet-4-5',
                  content: [{ type: 'text', text: 'ok' }],
                  stop_reason: 'end_turn',
                  usage: { input_tokens: 10, output_tokens: 1 },
                }
              : providerType === 'google'
                ? {
                    candidates: [
                      { content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' },
                    ],
                    usageMetadata: {
                      promptTokenCount: 10,
                      candidatesTokenCount: 1,
                      totalTokenCount: 11,
                    },
                  }
                : providerType === 'bedrock'
                  ? {
                      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
                      stopReason: 'end_turn',
                      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
                    }
                  : {
                      id: 'chatcmpl-test',
                      created: 1,
                      model: 'gpt-4o-mini',
                      choices: [
                        {
                          index: 0,
                          message: { role: 'assistant', content: 'ok' },
                          finish_reason: 'stop',
                        },
                      ],
                      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
                    };
          return Response.json(response);
        },
      }).model;
      const messages = [
        { role: 'user' as const, content: 'Actual learner reply' },
        hostSystemTailMessage('LATEST HOST STATE'),
      ];
      expect(
        (await generateText({ model, system: 'Fixed rules', messages, maxRetries: 0 })).text,
      ).toBe('ok');
      if (providerType === 'openai') {
        expect(request!.messages.map((m) => m.role)).toEqual(['system', 'user']);
        expect(request!.messages[0]!.content).toBe('Fixed rules\nLATEST HOST STATE');
      } else if (providerType === 'anthropic') {
        expect(request!.messages.map((m) => m.role)).toEqual(['user']);
        expect(request!.system).toEqual([{ type: 'text', text: 'Fixed rules\nLATEST HOST STATE' }]);
      } else if (providerType === 'bedrock') {
        expect(request!.messages.map((m) => m.role)).toEqual(['user']);
        expect(request!.system).toEqual([{ text: 'Fixed rules\nLATEST HOST STATE' }]);
      } else {
        expect(request!.contents.map((m) => m.role)).toEqual(['user']);
        expect(request!.systemInstruction.parts).toEqual([
          { text: 'Fixed rules\nLATEST HOST STATE' },
        ]);
      }
    },
  );

  it.each([
    { providerId: 'ollama', modelId: 'gemma3:12b', baseUrl: 'http://127.0.0.1:11434/v1' },
    {
      providerId: 'self-hosted-vllm',
      modelId: 'mistral-7b-instruct',
      baseUrl: 'https://vllm.test/v1',
    },
    {
      providerId: 'openai',
      modelId: 'deepseek-v4.1-flash',
      baseUrl: 'https://unknown-relay.test/v1',
    },
    { providerId: 'deepseek', modelId: 'gemma3:12b', baseUrl: 'https://self-hosted.test/v1' },
  ])('defaults $providerId / $modelId to a leading system instruction', async (config) => {
    let roles: string[] = [];
    const model = getModel({
      ...config,
      providerId: config.providerId as never,
      providerType: 'openai',
      apiKey: 'synthetic-key',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        roles = body.messages.map((m: { role: string }) => m.role);
        if (roles.slice(1).includes('system'))
          return Response.json(
            { error: { message: 'System message must be first' } },
            { status: 400 },
          );
        expect(body.messages[0].content).toBe('RULES\nSTATE');
        return Response.json({
          id: 'format-test',
          created: 1,
          model: config.modelId,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        });
      },
    }).model;
    expect(
      (
        await generateText({
          model,
          system: 'RULES',
          messages: [{ role: 'user', content: 'learner' }, hostSystemTailMessage('STATE')],
          maxRetries: 0,
        })
      ).text,
    ).toBe('ok');
    expect(roles).toEqual(['system', 'user']);
  });

  it.each([
    { providerId: 'deepseek', baseUrl: undefined, placement: undefined },
    { providerId: 'verified-gateway', baseUrl: 'https://gateway.test/v1', placement: 'trailing' },
  ] as const)('retains a tail only for verified $providerId capability', async (config) => {
    let roles: string[] = [];
    const model = getModel({
      providerId: config.providerId as never,
      providerType: 'openai',
      modelId: 'deepseek-v4.1-flash',
      apiKey: 'synthetic-key',
      baseUrl: config.baseUrl,
      requestSystemTailPlacement: config.placement,
      fetchImpl: async (_url, init) => {
        roles = JSON.parse(String(init?.body)).messages.map((m: { role: string }) => m.role);
        return Response.json({
          id: 'verified-tail',
          created: 1,
          model: 'deepseek-v4.1-flash',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        });
      },
    }).model;
    expect(
      (
        await generateText({
          model,
          system: 'RULES',
          messages: [{ role: 'user', content: 'learner' }, hostSystemTailMessage('STATE')],
          maxRetries: 0,
        })
      ).text,
    ).toBe('ok');
    expect(roles).toEqual(['system', 'user', 'system']);
  });
});
