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
  shouldFallbackFor: vi.fn(),
  logFallbackFired: vi.fn(),
  isEmptyLlmOutput: vi.fn((text: string | null | undefined) => !text || text.trim().length === 0),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: aiMock.generateText,
  streamText: aiMock.streamText,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => loggerMock),
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
    fallbackMock.shouldFallbackFor.mockReset();
    fallbackMock.logFallbackFired.mockReset();
    loggerMock.debug.mockClear();
    loggerMock.info.mockClear();
    loggerMock.warn.mockClear();
    loggerMock.error.mockClear();
    fallbackMock.isEmptyLlmOutput.mockClear();
    aiMock.generateText.mockResolvedValue(okResult());
  });

  it('does not fall back when resolveFallbackModel returns null', async () => {
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue(null);
    aiMock.generateText.mockRejectedValueOnce(
      Object.assign(new Error('upstream timeout'), { statusCode: 408 }),
    );

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
          prompt: 'hi',
        } as never,
        'scene-content',
      ),
    ).rejects.toMatchObject({ statusCode: 408 });
    // Exactly one call: no retry on the primary either (retries=0), no fallback.
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });

  it('falls back once on a retryable error and returns the fallback result', async () => {
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue({
      model: 'fallback-model' as never,
      modelString: 'qwen:deepseek-v4-pro',
    });
    aiMock.generateText
      .mockRejectedValueOnce(Object.assign(new Error('quota exceeded'), { statusCode: 429 }))
      .mockResolvedValueOnce(okResult());

    const result = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'hi',
      } as never,
      'scene-content',
      undefined,
      undefined,
      { serverManaged: true },
    );

    expect(result.text).toBe('ok');
    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
    // Second round carries the fallback model.
    const secondParams = aiMock.generateText.mock.calls[1][0] as { model: unknown };
    expect(secondParams.model).toBe('fallback-model');
  });

  it('only runs the fallback once when it also fails', async () => {
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue({
      model: 'fallback-model' as never,
      modelString: 'qwen:deepseek-v4-pro',
    });
    const primary = Object.assign(new Error('timeout'), { statusCode: 408 });
    const fallbackFail = Object.assign(new Error('still down'), { statusCode: 503 });
    aiMock.generateText.mockRejectedValueOnce(primary).mockRejectedValueOnce(fallbackFail);

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
          prompt: 'hi',
        } as never,
        'scene-content',
        undefined,
        undefined,
        { serverManaged: true },
      ),
    ).rejects.toBe(fallbackFail);
    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
  });

  it('does not fall back when fallback is disabled for the call', async () => {
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue({
      model: 'fallback-model' as never,
      modelString: 'qwen:deepseek-v4-pro',
    });
    aiMock.generateText.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { statusCode: 408 }),
    );

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
          prompt: 'hi',
        } as never,
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
    // The whitespace-only text is classified as a retryable empty output.
    fallbackMock.shouldFallbackFor.mockImplementation(
      (error: unknown, text: string | null | undefined) =>
        error !== undefined ? false : !text || text.trim().length === 0,
    );
    fallbackMock.resolveFallbackModel.mockResolvedValue({
      model: 'fallback-model' as never,
      modelString: 'qwen:deepseek-v4-pro',
    });
    aiMock.generateText
      .mockResolvedValueOnce({ ...okResult(), text: '   ' })
      .mockResolvedValueOnce({ ...okResult(), text: '   ' })
      .mockResolvedValueOnce(okResult());

    const result = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'hi',
      } as never,
      'scene-content',
      { retries: 1 },
      undefined,
      { serverManaged: true },
    );

    expect(result.text).toBe('ok');
    // Primary round (empty) + same-model retry + fallback round.
    expect(aiMock.generateText).toHaveBeenCalledTimes(3);
  });

  it('does not arm the fallback when the primary is not server-managed', async () => {
    // resolveModel stamps serverManaged on its result; a caller that does not
    // pass it through (a client-supplied x-model) must never reach the
    // operator's fallback key, even when the primary fails retryably.
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
    aiMock.generateText.mockRejectedValueOnce(
      Object.assign(new Error('quota exceeded'), { statusCode: 429 }),
    );

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
          prompt: 'hi',
        } as never,
        'scene-content',
      ),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    expect(fallbackMock.resolveFallbackModel).not.toHaveBeenCalled();
    expect(fallbackMock.logFallbackFired).not.toHaveBeenCalled();
  });

  it('does not fall back on a content-filter finish', async () => {
    // A SAFETY block that returns empty text looks exactly like an empty
    // output — but it is a refusal, so the fallback must stay untouched.
    fallbackMock.shouldFallbackFor.mockImplementation(
      (error: unknown, text: string | null | undefined) =>
        error !== undefined ? false : !text || text.trim().length === 0,
    );
    fallbackMock.resolveFallbackModel.mockResolvedValue({
      model: 'fallback-model' as never,
      modelString: 'qwen:deepseek-v4-pro',
    });
    aiMock.generateText.mockResolvedValue({
      ...okResult(),
      text: '',
      finishReason: 'content-filter',
    });

    const result = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'hi',
      } as never,
      'scene-content',
      { retries: 1 },
      undefined,
      { serverManaged: true },
    );

    expect(result.finishReason).toBe('content-filter');
    // A refusal cannot change on a same-model retry: the primary loop breaks
    // after the first content-filter finish, so only ONE call happens.
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    const calledModels = aiMock.generateText.mock.calls.map(
      (c) => (c[0] as { model: unknown }).model,
    );
    expect(calledModels.every((m) => m !== 'fallback-model')).toBe(true);
    expect(fallbackMock.logFallbackFired).not.toHaveBeenCalled();
  });

  it('skips the no-fallback-configured warning when no fallback model exists', async () => {
    // With MODEL_FALLBACK unset, every retryable exhaustion used to log
    // "fallback requested but none configured" — pure noise. The final error
    // is the signal; the warn must stay silent.
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue(null);
    const firstFailure = Object.assign(new Error('upstream unavailable'), { statusCode: 503 });
    const secondFailure = Object.assign(new Error('upstream unavailable again'), {
      statusCode: 503,
    });
    aiMock.generateText.mockRejectedValueOnce(firstFailure).mockRejectedValueOnce(secondFailure);

    await expect(
      callLLM(
        {
          model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
          prompt: 'hi',
        } as never,
        'scene-content',
        { retries: 1 },
      ),
    ).rejects.toBe(secondFailure);

    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
    const noneConfigured = loggerMock.warn.mock.calls.filter((c) =>
      String(c[0]).includes('none configured'),
    );
    expect(noneConfigured).toHaveLength(0);
  });

  it('keeps existing behaviour when no fallback configured', async () => {
    fallbackMock.shouldFallbackFor.mockReturnValue(true);
    fallbackMock.resolveFallbackModel.mockResolvedValue(null);
    aiMock.generateText
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { statusCode: 408 }))
      .mockResolvedValueOnce(okResult());

    // retries=1 means the same-model retry is used; fallback is absent.
    const result = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'hi',
      } as never,
      'scene-content',
      { retries: 1 },
    );
    expect(result.text).toBe('ok');
    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
  });

  it('does not fall back when a non-empty result fails a custom validator', async () => {
    // A non-empty output that fails a caller-supplied validator (format/JSON
    // check) is "output quality is off", not an empty output — the fallback
    // model's quota must not be spent on it.
    fallbackMock.shouldFallbackFor.mockImplementation(
      (error: unknown, text: string | null | undefined) =>
        error !== undefined ? false : !text || text.trim().length === 0,
    );
    fallbackMock.resolveFallbackModel.mockResolvedValue({
      model: 'fallback-model' as never,
      modelString: 'qwen:deepseek-v4-pro',
    });
    const badOutput = { ...okResult(), text: '[not valid json]' };
    aiMock.generateText.mockResolvedValue(badOutput);

    const result = await callLLM(
      {
        model: { provider: 'openai.responses', modelId: 'gpt-5.4' } as never,
        prompt: 'hi',
      } as never,
      'scene-content',
      { retries: 1, validate: () => false },
    );

    expect(result.text).toBe('[not valid json]');
    // Primary + same-model retry only. The up-front resolveFallbackModel call
    // is a config probe (it also arms the empty-output gate), but no fallback
    // round runs and no fallback log fires.
    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
    expect(fallbackMock.logFallbackFired).not.toHaveBeenCalled();
    const calledModels = aiMock.generateText.mock.calls.map(
      (c) => (c[0] as { model: unknown }).model,
    );
    expect(calledModels.every((m) => m !== 'fallback-model')).toBe(true);
  });
});
