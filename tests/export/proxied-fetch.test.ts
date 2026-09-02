import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { createProxiedFetch } from '@/lib/export/proxied-fetch';

describe('createProxiedFetch', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the original url to /api/proxy-media and returns the proxy response', async () => {
    const spy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('BYTES', { status: 200, headers: { 'content-type': 'text/javascript' } }),
    );
    vi.stubGlobal('fetch', spy);
    const pfetch = createProxiedFetch();
    const controller = new AbortController();
    const res = await pfetch('https://cdn.tailwindcss.com', { signal: controller.signal });
    // The shared proxy request runs on the module's INTERNAL controller (R2-P2-5):
    // the caller's signal is raced per-call and must NOT be forwarded to fetch.
    const fetchInit = spy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(spy).toHaveBeenCalledWith(
      '/api/proxy-media',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ url: 'https://cdn.tailwindcss.com' }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchInit?.signal).not.toBe(controller.signal);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('BYTES');
  });

  it('handles URL objects', async () => {
    const spy = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await createProxiedFetch()(new URL('https://x/y.css'));
    expect(spy).toHaveBeenCalledWith(
      '/api/proxy-media',
      expect.objectContaining({
        body: JSON.stringify({ url: 'https://x/y.css' }),
      }),
    );
  });

  it.each([
    ['/assets/local.png', undefined],
    ['blob:https://app.example/asset-id', undefined],
    ['data:text/plain;base64,QQ==', undefined],
    ['https://app.example/assets/local.png', 'https://app.example/classrooms/1'],
  ])('fetches local or browser-owned URL %s directly', async (url, pageHref) => {
    if (pageHref) vi.stubGlobal('location', new URL(pageHref));
    const spy = vi.fn(async () => new Response('BYTES'));
    vi.stubGlobal('fetch', spy);
    const controller = new AbortController();

    await createProxiedFetch({ crossOriginOnly: true })(url, { signal: controller.signal });

    expect(spy).toHaveBeenCalledWith(url, { signal: controller.signal });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('falls back to the proxy when a direct cross-origin request is blocked', async () => {
    const proxyResponse = new Response('BYTES');
    const spy = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(proxyResponse);
    vi.stubGlobal('fetch', spy);
    const controller = new AbortController();

    const response = await createProxiedFetch({ crossOriginOnly: true, directFirst: true })(
      'https://cdn.example/audio.mp3',
      { signal: controller.signal },
    );

    // The fallback reads the proxy bytes through the caller-visible response
    // (a clone of the shared one), and the shared fetch runs on the internal
    // controller, never the caller's signal.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('BYTES');
    expect(spy).toHaveBeenNthCalledWith(1, 'https://cdn.example/audio.mp3', {
      signal: controller.signal,
    });
    expect(spy).toHaveBeenNthCalledWith(
      2,
      '/api/proxy-media',
      expect.objectContaining({
        body: JSON.stringify({ url: 'https://cdn.example/audio.mp3' }),
        signal: expect.any(AbortSignal),
      }),
    );
    const proxyInit = spy.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(proxyInit?.signal).not.toBe(controller.signal);
  });
});
