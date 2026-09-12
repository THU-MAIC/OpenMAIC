import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '@/lib/generation/retry';

describe('withRetry', () => {
  it('retries with exponential delays and returns the eventual result', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockRejectedValueOnce(new Error('temporary')).mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { sleep, baseDelayMs: 10 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 20, undefined);
  });

  it('stops at the retry limit and respects a retry predicate', async () => {
    const err = new Error('bad request');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 3, shouldRetry: () => false, sleep: vi.fn() })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not start work after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn().mockResolvedValue('nope');
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
  });
});
