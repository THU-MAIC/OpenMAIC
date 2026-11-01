import { afterEach, describe, expect, it, vi } from 'vitest';
import { kimi, kimiFetchEndpoint } from '@/lib/web-fetch/providers/kimi';

const proxyFetch = vi.hoisted(() =>
  vi.fn((input: string | URL, init?: RequestInit, _options?: unknown) => fetch(input, init)),
);
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));

const url = 'https://example.com/page';
afterEach(() => vi.unstubAllGlobals());

describe('Kimi web fetch adapter', () => {
  it.each([
    ['https://api.moonshot.cn/v1', '/tools/fetch'],
    ['https://api.moonshot.ai/v1/', '/tools/fetch'],
    ['https://api.kimi.com/coding/v1', '/fetch'],
    ['https://api.kimi.ai/coding/v1/', '/fetch'],
    ['https://proxy.example/v1', '/tools/fetch'],
  ])('selects the endpoint from API identity: %s', async (baseUrl, path) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ url, title: 'Title', markdown: 'Body' }));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    expect(
      await kimi.extract(url, {
        credentials: { apiKey: 'test-key', baseUrl },
        signal: controller.signal,
      }),
    ).toEqual({ finalUrl: url, title: 'Title', markdown: 'Body' });
    expect(fetch).toHaveBeenCalledWith(
      baseUrl.replace(/\/+$/, '') + path,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it.each([
    new TypeError('fetch failed'),
    Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }),
    new Error('DNS failure', { cause: Object.assign(new Error('DNS'), { code: 'ENOTFOUND' }) }),
    Object.assign(new Error('TLS failure'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
  ])('retries one transport failure before succeeding: %s', async (error) => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(Response.json({ markdown: 'Recovered' }));
    vi.stubGlobal('fetch', fetch);
    await expect(kimi.extract(url, { credentials: { apiKey: 'test-key' } })).resolves.toEqual({
      markdown: 'Recovered',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal).toBe(fetch.mock.calls[0][1].signal);
  });
  it('fails cleanly after two transport errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetch);
    await expect(kimi.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
      'fetch failed',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not retry a transport error after caller cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(() => {
      controller.abort(new Error('Cancelled'));
      return Promise.reject(new TypeError('fetch failed'));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(
      kimi.extract(url, {
        credentials: { apiKey: 'test-key' },
        signal: controller.signal,
      }),
    ).rejects.toThrow('Cancelled');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry other errors thrown by the transport', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Invalid request'));
    vi.stubGlobal('fetch', fetch);
    await expect(kimi.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
      'Invalid request',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps the original overall deadline while the second attempt stalls', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          }),
      );
    vi.stubGlobal('fetch', fetch);
    await expect(
      kimi.extract(url, { credentials: { apiKey: 'test-key' }, bodyTimeoutMs: 100 }),
    ).rejects.toThrow(/aborted|Timed out/i);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal).toBe(fetch.mock.calls[0][1].signal);
  });
  it('accepts the content alias for compatibility', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ content: 'Body' })));
    expect(
      await kimi.extract(url, {
        credentials: { apiKey: 'test-key', baseUrl: 'https://api.kimi.com/coding/v1' },
      }),
    ).toEqual({ markdown: 'Body' });
  });
  it.each([401, 403, 404, 429, 500, 502, 504])(
    'maps HTTP %i without exposing the error body',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { message: 'secret echoed by upstream' } }, { status }),
        );
      vi.stubGlobal('fetch', fetch);
      await expect(kimi.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
        `Web fetch provider returned HTTP ${status}`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, {}, { markdown: 123 }, { content: [] }])(
    'refuses invalid responses',
    async (result) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
      await expect(kimi.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
        /response/i,
      );
    },
  );
  it('requires credentials before calling fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(kimi.extract(url, {})).rejects.toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the existing provider default endpoint', () => {
    expect(kimi.resolveCredentials({ apiKey: 'test-key' })).toEqual({
      apiKey: 'test-key',
      baseUrl: kimi.defaultBaseUrl,
    });
  });
  it.each([
    'https://api.kimi.com/coding/v1?key=secret',
    'https://user:pass@api.kimi.com/coding/v1',
    'https://api.moonshot.cn/v1#fragment',
  ])('refuses ambiguous API bases', (base) => {
    expect(() => kimiFetchEndpoint(base)).toThrow(/Invalid/);
    expect(kimi.acceptsWorkspaceBaseUrl?.(base)).toBe(false);
  });
  it('does not start an already aborted request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      kimi.extract(url, { credentials: { apiKey: 'test-key' }, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('propagates cancellation while a request is pending', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          }),
      ),
    );
    const result = kimi.extract(url, {
      credentials: { apiKey: 'test-key' },
      signal: controller.signal,
    });
    controller.abort(new Error('Cancelled'));
    await expect(result).rejects.toThrow('Cancelled');
  });
  it('enforces the absolute body deadline on a stalled response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))),
    );
    await expect(
      kimi.extract(url, { credentials: { apiKey: 'test-key' }, bodyTimeoutMs: 20 }),
    ).rejects.toThrow(/aborted|Timed out/i);
  });
  it('bounds the JSON transport before parsing an oversized body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ markdown: 'x'.repeat(70_000) })),
    );
    await expect(
      kimi.extract(url, { credentials: { apiKey: 'test-key' }, maxBytes: 10 }),
    ).rejects.toThrow(/byte limit/);
  });
});

it('forwards an operator proxy while retaining transport deadlines', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ markdown: 'Body' })));
  await kimi.extract(url, {
    credentials: {
      apiKey: 'test-key',
      proxy: 'http://proxy.example:8080',
      options: { custom: true },
    },
  });
  expect(proxyFetch).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), {
    proxy: 'http://proxy.example:8080',
    timeouts: { connectTimeout: 5000, headersTimeout: 10000, bodyTimeout: 30000 },
  });
});
