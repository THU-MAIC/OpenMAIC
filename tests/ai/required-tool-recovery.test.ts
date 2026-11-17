import { describe, expect, it } from 'vitest';
import { jsonSchema, tool } from 'ai';
import { getModel } from '@/lib/ai/providers';
import { callLLM } from '@/lib/ai/llm';

function reply(provider: string) {
  if (provider === 'anthropic')
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 1 },
    };
  if (provider === 'google')
    return {
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 },
    };
  if (provider === 'bedrock')
    return {
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
    };
  return {
    id: 'chatcmpl-test',
    created: 1,
    model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  };
}

describe('required-tool recovery transport', () => {
  it.each(['openai', 'deepseek', 'anthropic', 'google', 'bedrock'] as const)(
    'serializes a required tool with thinking disabled through the real %s adapter',
    async (provider) => {
      let request: Record<string, unknown> | undefined;
      const providerType = provider === 'deepseek' ? 'openai' : provider;
      const model = getModel({
        providerId: provider as never,
        providerType,
        modelId:
          provider === 'deepseek'
            ? 'deepseek-chat'
            : provider === 'anthropic'
              ? 'claude-sonnet-4-5'
              : provider === 'google'
                ? 'gemini-2.5-flash'
                : 'gpt-4o-mini',
        apiKey: 'synthetic-key',
        baseUrl: 'https://protocol-test.invalid/v1',
        fetchImpl: async (_url, init) => {
          request = JSON.parse(String(init?.body));
          return Response.json(reply(provider));
        },
      }).model;
      await callLLM(
        {
          model,
          prompt: 'Record the already delivered response using the available tool.',
          tools: {
            record_response: tool({
              description: 'Record a response without approving or advancing learning.',
              inputSchema: jsonSchema({
                type: 'object',
                properties: { response: { type: 'string' } },
                required: ['response'],
              }),
            }),
          },
          toolChoice: 'required',
          maxRetries: 0,
        },
        'required-tool-recovery-test',
        undefined,
        { mode: 'disabled' },
      );

      const body = request!;
      if (provider === 'anthropic') {
        expect(body.tool_choice).toMatchObject({ type: 'any' });
        expect(body.thinking).not.toMatchObject({ type: 'enabled' });
      } else if (provider === 'google') {
        expect(body.toolConfig).toMatchObject({ functionCallingConfig: { mode: 'ANY' } });
      } else if (provider === 'bedrock') {
        expect(body.toolConfig).toMatchObject({ toolChoice: { any: {} } });
      } else {
        expect(body.tool_choice).toBe('required');
        if (provider === 'deepseek') expect(body.thinking).toEqual({ type: 'disabled' });
      }
    },
  );
});
