import { beforeEach, describe, expect, it, vi } from 'vitest';

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

const usageMock = vi.hoisted(() => ({
  normalizeUsage: vi.fn((usage: unknown) => usage),
  recordUsage: vi.fn(async () => undefined),
}));

const fallbackMock = vi.hoisted(() => ({
  resolveFallbackModel: vi.fn(),
  isRetryableLlmError: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));

vi.mock('@/lib/usage/normalize', () => ({
  normalizeUsage: usageMock.normalizeUsage,
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordUsage: usageMock.recordUsage,
}));

vi.mock('@/lib/server/llm-fallback', () => fallbackMock);

import { callLLM } from '@/lib/ai/llm';
import type { GenerateTextResult } from 'ai';

function okResult(): GenerateTextResult<never, never> {
  return { text: 'ok', usage: {}, totalUsage: {}, sources: [], steps: [] } as never;
}

describe('callLLM retryable-failure fallback', () => {
  beforeEach(() => {
    aiMock.generateText.mockReset();
    fallbackMock.resolveFallbackModel.mockReset();
    fallbackMock.isRetryableLlmError.mockReset();
    aiMock.generateText.mockResolvedValue(okResult());
  });

  it('does not fall back when resolveFallbackModel returns null', async () => {
    fallbackMock.isRetryableLlmError.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue(null);
    aiMock.generateText.mockRejectedValueOnce(Object.assign(new Error('upstream timeout'), { statusCode: 408 }));

    await expect(
      callLLM(
        { model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never, prompt: 'hi' } as never,
        'scene-content',
      ),
    ).rejects.toMatchObject({ statusCode: 408 });
    // Exactly one call: no retry on the primary either (retries=0), no fallback.
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });

  it('falls back once on a retryable error and returns the fallback result', async () => {
    fallbackMock.isRetryableLlmError.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue({ model: 'fallback-model' as never, modelString: 'qwen:deepseek-v4-pro' });
    aiMock.generateText
      .mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { statusCode: 429 }))
      .mockResolvedValueOnce(okResult());

    const result = await callLLM(
      { model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never, prompt: 'hi' } as never,
      'scene-content',
    );

    expect(result.text).toBe('ok');
    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
    // Second round carries the fallback model.
    const secondParams = aiMock.generateText.mock.calls[1][0] as { model: unknown };
    expect(secondParams.model).toBe('fallback-model');
  });

  it('only runs the fallback once when it also fails', async () => {
    fallbackMock.isRetryableLlmError.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue({ model: 'fallback-model' as never, modelString: 'qwen:deepseek-v4-pro' });
    const primary = Object.assign(new Error('timeout'), { statusCode: 408 });
    const fallbackFail = Object.assign(new Error('still down'), { statusCode: 503 });
    aiMock.generateText.mockRejectedValueOnce(primary).mockRejectedValueOnce(fallbackFail);

    await expect(
      callLLM(
        { model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never, prompt: 'hi' } as never,
        'scene-content',
      ),
    ).rejects.toBe(fallbackFail);
    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
  });

  it('does not fall back when fallback is disabled for the call', async () => {
    fallbackMock.isRetryableLlmError.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue({ model: 'fallback-model' as never, modelString: 'qwen:deepseek-v4-pro' });
    aiMock.generateText.mockRejectedValueOnce(Object.assign(new Error('timeout'), { statusCode: 408 }));

    await expect(
      callLLM(
        { model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never, prompt: 'hi' } as never,
        'verify-model',
        undefined,
        undefined,
        { enabled: false },
      ),
    ).rejects.toMatchObject({ statusCode: 408 });
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    expect(fallbackMock.resolveFallbackModel).not.toHaveBeenCalled();
  });

  it('falls back on an empty-output validation failure when retries are set and exhausted', async () => {
    fallbackMock.resolveFallbackModel.mockResolvedValue({ model: 'fallback-model' as never, modelString: 'qwen:deepseek-v4-pro' });
    aiMock.generateText
      .mockResolvedValueOnce({ ...okResult(), text: '   ' })
      .mockResolvedValueOnce({ ...okResult(), text: '   ' })
      .mockResolvedValueOnce(okResult());

    const result = await callLLM(
      { model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never, prompt: 'hi' } as never,
      'scene-content',
      { retries: 1 },
    );

    expect(result.text).toBe('ok');
    // Primary round (empty) + same-model retry + fallback round.
    expect(aiMock.generateText).toHaveBeenCalledTimes(3);
  });

  it('keeps existing behaviour when no fallback configured', async () => {
    fallbackMock.isRetryableLlmError.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue(null);
    aiMock.generateText
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { statusCode: 408 }))
      .mockResolvedValueOnce(okResult());

    // retries=1 means the same-model retry is used; fallback is absent.
    const result = await callLLM(
      { model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never, prompt: 'hi' } as never,
      'scene-content',
      { retries: 1 },
    );
    expect(result.text).toBe('ok');
    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
  });
});