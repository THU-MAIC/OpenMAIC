import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchModels, ModelFetchError } from '@/lib/server/model-fetch';

function stalled(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function successful() {
  return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model' }] }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('model discovery deadlines and retries', () => {
  it.each(['headers', 'body'])(
    'bounds stalled %s across both attempts to 30 seconds',
    async (phase) => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const fetchMock = vi.fn((_url, init) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        if (phase === 'headers') return stalled(signal);
        return Promise.resolve({ ok: true, status: 200, json: () => stalled(signal) });
      });
      vi.stubGlobal('fetch', fetchMock);
      const result = fetchModels('https://example.com', '').catch((error) => error);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(signals[0].aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(signals[0].aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ name: 'TimeoutError' });
      expect(signals.every((s) => s.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('uses one deadline for headers plus body, and succeeds on its single retry', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(async (_url, init) => {
      signals.push(init.signal);
      if (signals.length === 2) return successful();
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return { ok: true, status: 200, json: () => stalled(init.signal) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchModels('https://example.com', '');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual([{ id: 'model', ownedBy: undefined }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a slow successful body within the original 15-second allowance', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((resolve) => setTimeout(() => resolve({ data: [{ id: 'slow' }] }), 14_999)),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchModels('https://example.com', '');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(await result).toEqual([{ id: 'slow', ownedBy: undefined }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 500])(
    'preserves terminal HTTP %i when its error body stalls',
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi.fn(async (_url, init) => ({
        ok: false,
        status,
        text: () => stalled(init.signal),
      }));
      vi.stubGlobal('fetch', fetchMock);
      const result = fetchModels('https://example.com', '').catch((error) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toBeInstanceOf(ModelFetchError);
      expect(await result).toMatchObject({ status });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('retries a transport failure once', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(successful());
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchModels('https://example.com', '')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry malformed JSON', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad JSON');
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchModels('https://example.com', '')).rejects.toBeInstanceOf(SyntaxError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not restart the total budget when moving to a fallback URL', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url, init) => {
      if (fetchMock.mock.calls.length === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return { ok: false, status: 404 };
      }
      return { ok: true, status: 200, json: () => stalled(init.signal) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = fetchModels('https://example.com/anthropic', '').catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://example.com/anthropic/v1/models',
      'https://example.com/v1/models',
      'https://example.com/v1/models',
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
