import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepseek } from '@/lib/web-fetch/providers/deepseek';

const proxyFetch = vi.hoisted(() =>
  vi.fn((input: string | URL, init?: RequestInit, _options?: unknown) => fetch(input, init)),
);
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));

import { deepseekToolsEndpoint } from '@/lib/web-search/deepseek-endpoint';

const url = 'https://example.com/page';
afterEach(() => vi.unstubAllGlobals());

describe('DeepSeek web fetch adapter', () => {
  it.each([
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/tools/fetch'],
    ['https://api.deepseek.com/v1///', 'https://api.deepseek.com/v1/tools/fetch'],
    ['https://api.deepseek.com/beta', 'https://api.deepseek.com/v1/tools/fetch'],
    ['https://api.deepseek.com/beta/', 'https://api.deepseek.com/v1/tools/fetch'],
    ['https://api.deepseek.com/custom/prefix/v2', 'https://api.deepseek.com/v1/tools/fetch'],
    ['https://proxy.example/beta', 'https://proxy.example/beta/tools/fetch'],
    [
      'https://proxy.example/custom/prefix/v2',
      'https://proxy.example/custom/prefix/v2/tools/fetch',
    ],
    ['https://proxy.example/v1', 'https://proxy.example/v1/tools/fetch'],
    ['https://proxy.example/gateway/v1/', 'https://proxy.example/gateway/v1/tools/fetch'],
  ])('normalizes official bases and preserves gateway prefixes: %s', async (baseUrl, endpoint) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ title: 'Title', content: 'Body' }));
    vi.stubGlobal('fetch', fetch);
    expect(await deepseek.extract(url, { credentials: { apiKey: 'test-key', baseUrl } })).toEqual({
      title: 'Title',
      markdown: 'Body',
    });
    expect(fetch).toHaveBeenCalledWith(
      endpoint,
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
      .mockResolvedValueOnce(Response.json({ content: 'Recovered' }));
    vi.stubGlobal('fetch', fetch);
    await expect(deepseek.extract(url, { credentials: { apiKey: 'test-key' } })).resolves.toEqual({
      markdown: 'Recovered',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal).toBe(fetch.mock.calls[0][1].signal);
  });
  it('fails cleanly after two transport errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetch);
    await expect(deepseek.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
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
      deepseek.extract(url, {
        credentials: { apiKey: 'test-key' },
        signal: controller.signal,
      }),
    ).rejects.toThrow('Cancelled');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry other errors thrown by the transport', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Invalid request'));
    vi.stubGlobal('fetch', fetch);
    await expect(deepseek.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
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
      deepseek.extract(url, { credentials: { apiKey: 'test-key' }, bodyTimeoutMs: 100 }),
    ).rejects.toThrow(/aborted|Timed out/i);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal).toBe(fetch.mock.calls[0][1].signal);
  });
  it('omits an empty title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ content: 'Body', title: '  ' })),
    );
    expect(
      await deepseek.extract(url, {
        credentials: { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com/v1' },
      }),
    ).toEqual({ markdown: 'Body' });
  });
  it.each([400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 504])(
    'maps HTTP %i without exposing the error body',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { message: 'secret echoed by upstream' } }, { status }),
        );
      vi.stubGlobal('fetch', fetch);
      await expect(deepseek.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
        status === 403
          ? 'Unable to fetch page: DeepSeek safety policy refused the URL (HTTP 403)'
          : status === 404
            ? 'Unable to fetch page: DeepSeek found no usable content (HTTP 404)'
            : `Web fetch provider returned HTTP ${status}`,
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, {}, { markdown: 123 }, { content: [] }])(
    'refuses invalid responses',
    async (result) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
      await expect(deepseek.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
        /response/i,
      );
    },
  );
  it('requires credentials before calling fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(deepseek.extract(url, {})).rejects.toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses the existing provider default endpoint', () => {
    expect(deepseek.resolveCredentials({ apiKey: 'test-key' })).toEqual({
      apiKey: 'test-key',
      baseUrl: deepseek.defaultBaseUrl,
    });
  });
  it.each([
    'https://api.deepseek.com/v1?key=secret',
    'https://user:pass@api.deepseek.com/coding/v1',
    'https://api.deepseek.com/v1#fragment',
  ])('refuses ambiguous API bases', (base) => {
    expect(() => deepseekToolsEndpoint(base, 'fetch')).toThrow(/Invalid/);
    expect(deepseek.acceptsWorkspaceBaseUrl?.(base)).toBe(false);
  });
  it('does not start an already aborted request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      deepseek.extract(url, { credentials: { apiKey: 'test-key' }, signal: AbortSignal.abort() }),
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
    const result = deepseek.extract(url, {
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
      deepseek.extract(url, { credentials: { apiKey: 'test-key' }, bodyTimeoutMs: 20 }),
    ).rejects.toThrow(/aborted|Timed out/i);
  });
  it('bounds the JSON transport before parsing an oversized body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ content: 'x'.repeat(70_000) })),
    );
    await expect(
      deepseek.extract(url, { credentials: { apiKey: 'test-key' }, maxBytes: 10 }),
    ).rejects.toThrow(/byte limit/);
  });
});

it('forwards an operator proxy while retaining transport deadlines', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ content: 'Body' })));
  await deepseek.extract(url, {
    credentials: {
      apiKey: 'test-key',
      proxy: 'http://proxy.example:8080',
      options: { custom: true },
    },
  });
  expect(proxyFetch).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), {
    proxy: 'http://proxy.example:8080',
    timeouts: { connectTimeout: 5000, headersTimeout: 30000, bodyTimeout: 30000 },
  });
});

it.each([
  'ftp://example.com',
  'https://user:pass@example.com',
  'https://example.com/' + 'x'.repeat(8192),
])('rejects an invalid fetch target before sending it: %s', async (url) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(deepseek.extract(url, { credentials: { apiKey: 'key' } })).rejects.toThrow(
    /Invalid/,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('shares the original header deadline across transport attempts', async () => {
  // Resolve the dynamic transport import before advancing the fake clock.
  await import('undici');
  vi.useFakeTimers();
  try {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const result = deepseek.extract(url, { credentials: { apiKey: 'key' } });
    let settled = false;
    result.catch(() => undefined).finally(() => (settled = true));
    const assertion = expect(result).rejects.toThrow('Web fetch headers timed out');
    // DeepSeek answers only after fetching the page, so 20s must not hit the header deadline.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
