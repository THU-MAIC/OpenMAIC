import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';

vi.mock('@/lib/server/usage-storage', () => ({ recordUsage: vi.fn(async () => undefined) }));

import { streamLLM } from '@/lib/ai/llm';
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

async function textOf(model: unknown, enabled?: boolean) {
  const result = streamLLM(
    { model, prompt: 'hi', maxRetries: 0 } as never,
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
});
