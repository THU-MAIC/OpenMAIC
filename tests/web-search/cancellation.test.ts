import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithBaidu } from '@/lib/web-search/baidu';
import { searchWithBocha } from '@/lib/web-search/bocha';
import { searchWithBrave } from '@/lib/web-search/brave';
import { searchWithDoubao } from '@/lib/web-search/doubao';
import { searchWithMiniMax } from '@/lib/web-search/minimax';
import { searchWithSearxng } from '@/lib/web-search/searxng';
import { searchWithTavily } from '@/lib/web-search/tavily';

describe('registered Web Search provider cancellation', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it.each([
    ['tavily', (signal: AbortSignal) => searchWithTavily({ query: 'q', apiKey: 'k', signal })],
    ['bocha', (signal: AbortSignal) => searchWithBocha({ query: 'q', apiKey: 'k', signal })],
    ['brave', (signal: AbortSignal) => searchWithBrave({ query: 'q', signal })],
    ['baidu', (signal: AbortSignal) => searchWithBaidu({ query: 'q', apiKey: 'k', signal })],
    ['minimax', (signal: AbortSignal) => searchWithMiniMax({ query: 'q', apiKey: 'k', signal })],
    ['doubao', (signal: AbortSignal) => searchWithDoubao({ query: 'q', apiKey: 'k', signal })],
    [
      'searxng',
      (signal: AbortSignal) =>
        searchWithSearxng({
          query: 'q',
          baseUrl: 'http://192.168.161.100:6060',
          signal,
        }),
    ],
  ])('%s passes the caller signal into every provider HTTP request', async (_name, invoke) => {
    const signal = new AbortController().signal;
    proxyFetchMock.mockRejectedValue(new Error('stop after request capture'));

    await invoke(signal).catch(() => undefined);

    expect(proxyFetchMock).toHaveBeenCalled();
    for (const [, init] of proxyFetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(init.signal).toBe(signal);
    }
  });

  it('aborting the caller signal cancels the in-flight provider request itself', async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | null | undefined;
    proxyFetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          providerSignal = init.signal;
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );

    const pending = searchWithTavily({
      query: 'current fact',
      apiKey: 'key',
      signal: controller.signal,
    });

    expect(providerSignal).toBe(controller.signal);
    controller.abort(new DOMException('request cancelled', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(providerSignal?.aborted).toBe(true);
  });
});
