import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

const usageMock = vi.hoisted(() => ({ recordUsage: vi.fn(async () => undefined) }));
vi.mock('@/lib/server/usage-storage', () => usageMock);

import { APICallError, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { streamLLM } from '@/lib/ai/llm';
import { PROVIDERS } from '@/lib/ai/providers';
import { attachModelFallback } from '@/lib/ai/model-fallbacks';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textModel(modelId: string, text: string) {
  return new MockLanguageModelV3({
    provider: 'mock',
    modelId,
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: text },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ],
      }),
    }),
  });
}

const overloaded = () =>
  Object.assign(new Error('overloaded'), { statusCode: 503, isRetryable: true });

async function textOf(model: unknown, enabled?: boolean, extra: Record<string, unknown> = {}) {
  const result = streamLLM(
    { model, prompt: 'hi', maxRetries: 0, ...extra } as never,
    'test-stream',
    undefined,
    enabled === undefined ? undefined : { enabled },
  );
  let text = '';
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text;
    if (part.type === 'error') throw part.error;
  }
  return text;
}

describe('streamLLM slot fallback', () => {
  let fallback: MockLanguageModelV3;
  beforeEach(() => {
    fallback = textModel('backup', 'from fallback');
  });

  const attach = (primary: MockLanguageModelV3) =>
    attachModelFallback(primary, async () => ({ model: fallback, modelString: 'mock:backup' }));

  it('streams on the fallback when the primary refuses the request', async () => {
    const primary = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => {
        throw overloaded();
      },
    });
    attach(primary);
    expect(await textOf(primary)).toBe('from fallback');
  });

  it('streams on the fallback when the first part is an error', async () => {
    const primary = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'error', error: overloaded() },
          ],
        }),
      }),
    });
    attach(primary);
    expect(await textOf(primary)).toBe('from fallback');
  });

  it('falls back on a transient error payload a provider streams as its first part', async () => {
    const payloadFailure = (type: string) =>
      new MockLanguageModelV3({
        provider: 'mock',
        modelId: 'main',
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'error', error: { type, message: 'upstream says no' } },
            ],
          }),
        }),
      });
    const overloadedPrimary = payloadFailure('overloaded_error');
    attach(overloadedPrimary);
    expect(await textOf(overloadedPrimary)).toBe('from fallback');

    const unauthorized = payloadFailure('authentication_error');
    attach(unauthorized);
    await expect(textOf(unauthorized)).rejects.toBeDefined();
    expect(fallback.doStreamCalls).toHaveLength(1);
  });

  it('keeps the primary once it has streamed content', async () => {
    const primary = textModel('main', 'from primary');
    attach(primary);
    expect(await textOf(primary)).toBe('from primary');
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it('does not fall back on a non-retryable failure, or when the caller opts out', async () => {
    const refused = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => {
        throw Object.assign(new Error('bad request'), { statusCode: 400 });
      },
    });
    attach(refused);
    await expect(textOf(refused)).rejects.toThrow('bad request');

    const overloadedPrimary = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => {
        throw overloaded();
      },
    });
    attach(overloadedPrimary);
    await expect(textOf(overloadedPrimary, false)).rejects.toThrow('overloaded');
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it('streams without a fallback when none is attached', async () => {
    expect(await textOf(textModel('main', 'plain'))).toBe('plain');
  });

  const refused = () =>
    new APICallError({
      message: 'overloaded',
      url: 'https://api.example/v1',
      requestBodyValues: {},
      statusCode: 503,
      isRetryable: true,
    });

  it("runs the primary's own retries first and the fallback once, last", async () => {
    const primary = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => {
        throw refused();
      },
    });
    attach(primary);
    expect(await textOf(primary, undefined, { maxRetries: 1 })).toBe('from fallback');
    expect(primary.doStreamCalls).toHaveLength(2);
    expect(fallback.doStreamCalls).toHaveLength(1);

    // A failing fallback is not retried either.
    fallback = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'backup',
      doStream: async () => {
        throw refused();
      },
    });
    const again = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => {
        throw refused();
      },
    });
    attach(again);
    await expect(textOf(again, undefined, { maxRetries: 1 })).rejects.toThrow('overloaded');
    expect(fallback.doStreamCalls).toHaveLength(1);
  }, 20_000);

  it('does not fall back in a later step once content reached the caller', async () => {
    let calls = 0;
    const primary = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => {
        calls += 1;
        if (calls > 1) throw overloaded();
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: 'thinking aloud' },
              { type: 'text-end', id: '1' },
              { type: 'tool-call', toolCallId: 't1', toolName: 'note', input: '{}' },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
            ],
          }),
        };
      },
    });
    attach(primary);
    const execute = vi.fn(async () => 'noted');
    await expect(
      textOf(primary, undefined, {
        tools: { note: tool({ inputSchema: z.object({}), execute }) },
        stopWhen: stepCountIs(3),
      }),
    ).rejects.toThrow('overloaded');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fallback.doStreamCalls).toHaveLength(0);
  });

  it('builds the thinking options for the fallback model, not the primary', async () => {
    // A model of each provider whose catalogue entry takes a reasoning setting.
    const thinkingModel = (providerId: 'openai' | 'anthropic') =>
      (
        PROVIDERS[providerId].models as {
          id: string;
          capabilities?: { thinking?: { control?: string; requestAdapter?: string } };
        }[]
      ).find(
        (model) =>
          model.capabilities?.thinking?.requestAdapter === providerId &&
          model.capabilities.thinking.control !== 'none',
      )!.id;
    const primary = new MockLanguageModelV3({
      provider: 'openai.chat',
      modelId: thinkingModel('openai'),
      doStream: async () => {
        throw overloaded();
      },
    });
    fallback = textModel(thinkingModel('anthropic'), 'from fallback');
    Object.assign(fallback, { provider: 'anthropic.messages' });
    attach(primary);
    const result = streamLLM({ model: primary, prompt: 'hi', maxRetries: 0 } as never, 'test', {
      mode: 'enabled',
      enabled: true,
      effort: 'high',
      budgetTokens: 4096,
    } as never);
    for await (const _part of result.fullStream) void _part;
    expect(primary.doStreamCalls[0]?.providerOptions).toHaveProperty('openai');
    const fallbackOptions = fallback.doStreamCalls[0]?.providerOptions;
    expect(fallbackOptions).toHaveProperty('anthropic');
    expect(fallbackOptions).not.toHaveProperty('openai');
  });

  it('records usage against the model that served the stream', async () => {
    usageMock.recordUsage.mockClear();
    const primary = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'main',
      doStream: async () => {
        throw overloaded();
      },
    });
    attach(primary);
    await textOf(primary);
    await vi.waitFor(() => expect(usageMock.recordUsage).toHaveBeenCalled());
    expect(JSON.stringify(usageMock.recordUsage.mock.calls)).toContain('backup');
    expect(JSON.stringify(usageMock.recordUsage.mock.calls)).not.toContain('"main"');
  });
});
