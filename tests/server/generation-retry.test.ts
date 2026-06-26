import { describe, expect, it, vi } from 'vitest';
import {
  isAbortError,
  isRetryableGenerationError,
  withGenerationRetry,
} from '@/lib/generation/generation-retry';

describe('generation retry helper', () => {
  it('retries retryable null results and reports the next backoff delay', async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn(async () => undefined);
    let attempts = 0;

    const result = await withGenerationRetry(
      async () => {
        attempts += 1;
        return attempts === 1 ? null : 'scene-ok';
      },
      {
        label: 'scene 1 content',
        maxRetries: 2,
        sleep,
        random: () => 0,
        shouldRetryResult: (value) => value === null,
        onRetry,
      },
    );

    expect(result).toBe('scene-ok');
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
    expect(onRetry).toHaveBeenCalledWith({
      label: 'scene 1 content',
      attempt: 1,
      maxAttempts: 3,
      nextDelayMs: 1000,
      reason: 'empty result',
    });
  });

  it('does not retry non-retryable errors', async () => {
    const sleep = vi.fn(async () => undefined);
    const unauthorized = Object.assign(new Error('Unauthorized'), { statusCode: 401 });

    await expect(
      withGenerationRetry(
        async () => {
          throw unauthorized;
        },
        {
          label: 'scene actions',
          maxRetries: 2,
          sleep,
        },
      ),
    ).rejects.toBe(unauthorized);

    expect(sleep).not.toHaveBeenCalled();
  });

  it('classifies transient provider and transport failures as retryable', () => {
    expect(isRetryableGenerationError({ statusCode: 429 })).toBe(true);
    expect(isRetryableGenerationError({ status: 503 })).toBe(true);
    expect(isRetryableGenerationError({ name: 'TimeoutError' })).toBe(true);
    expect(isRetryableGenerationError(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(isRetryableGenerationError({ isRetryable: true, statusCode: 400 })).toBe(true);
  });

  it('classifies permanent request and auth failures as non-retryable', () => {
    expect(isRetryableGenerationError({ statusCode: 400 })).toBe(false);
    expect(isRetryableGenerationError({ statusCode: 401 })).toBe(false);
    expect(isRetryableGenerationError({ statusCode: 403 })).toBe(false);
    expect(isRetryableGenerationError({ isRetryable: false, statusCode: 503 })).toBe(false);
    expect(isRetryableGenerationError({ name: 'AbortError' })).toBe(false);
    expect(isRetryableGenerationError({ name: 'AbortError', isRetryable: true })).toBe(false);
  });

  it('recognizes Error-shaped aborts outside the DOMException prototype chain', () => {
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });

    expect(isAbortError(abort)).toBe(true);
  });

  it('does not call the operation when its signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => 'scene-ok');

    await expect(
      withGenerationRetry(operation, {
        label: 'scene content',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(operation).not.toHaveBeenCalled();
  });

  it('passes its signal to a custom backoff sleep and stops before another attempt', async () => {
    const controller = new AbortController();
    const sleep = vi.fn(
      (_ms: number, signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
          controller.abort();
        }),
    );
    const operation = vi.fn(async () => {
      throw Object.assign(new Error('Rate limited'), { statusCode: 429 });
    });

    await expect(
      withGenerationRetry(operation, {
        label: 'scene content',
        signal: controller.signal,
        maxRetries: 1,
        random: () => 0,
        sleep,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(sleep).toHaveBeenCalledWith(1000, controller.signal);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('aborts the default backoff sleep without waiting for its timer', async () => {
    vi.useFakeTimers();

    try {
      const controller = new AbortController();
      const operation = vi.fn(async () => {
        throw Object.assign(new Error('Rate limited'), { statusCode: 429 });
      });
      const pending = withGenerationRetry(operation, {
        label: 'scene content',
        signal: controller.signal,
        maxRetries: 1,
        random: () => 0,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      const rejection = pending.then(
        () => undefined,
        (error) => error,
      );
      controller.abort();

      await expect(rejection).resolves.toMatchObject({ name: 'AbortError' });
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unwraps retry error containers before classifying', () => {
    expect(
      isRetryableGenerationError({
        name: 'AI_RetryError',
        lastError: { statusCode: 503 },
      }),
    ).toBe(true);

    expect(
      isRetryableGenerationError({
        name: 'AI_RetryError',
        errors: [{ statusCode: 400 }, { statusCode: 401 }],
      }),
    ).toBe(false);
  });
});
