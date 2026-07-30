import { afterEach, describe, expect, it, vi } from 'vitest';

import { resilientFetch } from '@/lib/utils/resilient-fetch';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function ok(body = 'ok') {
  return new Response(body, { status: 200 });
}

describe('resilientFetch', () => {
  it('returns the response on first success (single call)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const res = await resilientFetch('/api/x', { retries: 2, baseDelayMs: 1 });

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries transient network errors then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(ok('third'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await resilientFetch('/api/x', { retries: 3, baseDelayMs: 1 });

    expect(await res.text()).toBe('third');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry HTTP error statuses — returns the Response as-is', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await resilientFetch('/api/x', { retries: 3, baseDelayMs: 1 });

    expect(res.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1); // a 5xx is the caller's to handle
  });

  it('times out a stalled attempt and retries, then rejects after exhausting', async () => {
    // fetch that never resolves until its signal aborts (simulates a stalled link).
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resilientFetch('/api/x', { timeoutMs: 20, retries: 1, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // first attempt + one retry
  });

  it('propagates a caller abort immediately without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      resilientFetch('/api/x', { signal: controller.signal, retries: 3, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
