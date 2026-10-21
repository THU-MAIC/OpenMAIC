import { afterEach, describe, expect, it, vi } from 'vitest';
import { keenable, keenableFetchEndpoint } from '@/lib/web-fetch/providers/keenable';

const proxyFetch = vi.hoisted(() =>
  vi.fn((input: string | URL, init?: RequestInit, _options?: unknown) => fetch(input, init)),
);
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));

const url = 'https://example.com/page?a=1&b=2';
const fetched = (data: Record<string, unknown>) => Response.json(data);
afterEach(() => vi.unstubAllGlobals());

describe('Keenable web fetch adapter', () => {
  it.each([
    [undefined, 'https://api.keenable.ai/v1/fetch/public'],
    ['https://api.keenable.ai/', 'https://api.keenable.ai/v1/fetch/public'],
    ['https://api.keenable.ai/v1/fetch', 'https://api.keenable.ai/v1/fetch/public'],
  ])('calls the public fetch endpoint of %s without a key', async (baseUrl, endpoint) => {
    const fetch = vi.fn().mockResolvedValue(
      fetched({
        url: 'https://example.com/final',
        title: 'Title',
        content: '# Body',
        description: '',
        published_at: 1791488648,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await keenable.extract(url, { credentials: baseUrl ? { baseUrl } : {} })).toEqual({
      markdown: '# Body',
      title: 'Title',
      finalUrl: 'https://example.com/final',
    });
    const target = new URL(fetch.mock.calls[0][0]);
    expect(`${target.origin}${target.pathname}`).toBe(endpoint);
    expect(target.searchParams.get('url')).toBe(url);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/json', 'X-Keenable-Title': 'OpenMAIC' },
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it('sends an optional key to the keyed endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(fetched({ content: 'Body' }));
    vi.stubGlobal('fetch', fetch);
    await keenable.extract(url, { credentials: { apiKey: 'kn-key' } });
    expect(fetch.mock.calls[0][0]).toBe(
      keenableFetchEndpoint('https://api.keenable.ai', url, true),
    );
    expect(fetch.mock.calls[0][0]).toMatch(/^https:\/\/api\.keenable\.ai\/v1\/fetch\?url=/);
    expect(fetch.mock.calls[0][1].headers).toEqual({
      Accept: 'application/json',
      'X-Keenable-Title': 'OpenMAIC',
      'X-API-Key': 'kn-key',
    });
  });
  it('returns Markdown without optional metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetched({ content: 'Body' })));
    expect(await keenable.extract(url, {})).toEqual({ markdown: 'Body' });
  });
  it.each([401, 404, 429, 500, 502])(
    'maps HTTP %i without exposing the error body',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(Response.json({ error: 'secret echoed by upstream' }, { status }));
      vi.stubGlobal('fetch', fetch);
      const result = keenable.extract(url, {});
      await expect(result).rejects.toThrow(`Web fetch provider returned HTTP ${status}`);
      await expect(result).rejects.not.toThrow(/secret/);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, {}, { content: 123 }, { title: 'No body' }])(
    'refuses invalid responses: %j',
    async (result) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
      await expect(keenable.extract(url, {})).rejects.toThrow(/response|Markdown/i);
    },
  );
  it('defaults to the Keenable API without requiring a key', () => {
    expect(keenable.requiresApiKey).toBe(false);
    expect(keenable.resolveCredentials()).toEqual({ baseUrl: 'https://api.keenable.ai' });
  });
  it('lets workspaces use only the official API base', () => {
    expect(keenable.acceptsWorkspaceBaseUrl?.('https://api.keenable.ai')).toBe(true);
    expect(keenable.acceptsWorkspaceBaseUrl?.('https://api.keenable.ai/')).toBe(true);
    expect(keenable.acceptsWorkspaceBaseUrl?.('https://keenable.internal.example')).toBe(false);
  });
  it('does not start an already aborted request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(keenable.extract(url, { signal: AbortSignal.abort() })).rejects.toThrow();
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
    const result = keenable.extract(url, { signal: controller.signal });
    controller.abort(new Error('Cancelled'));
    await expect(result).rejects.toThrow('Cancelled');
  });
  it('enforces the absolute body deadline on a stalled response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} }))),
    );
    await expect(keenable.extract(url, { bodyTimeoutMs: 20 })).rejects.toThrow(
      /aborted|Timed out/i,
    );
  });
  it('bounds the JSON transport before parsing an oversized body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetched({ content: 'x'.repeat(70_000) })));
    await expect(keenable.extract(url, { maxBytes: 10 })).rejects.toThrow(/byte limit/);
  });
  it('forwards an operator proxy and gives the fetch the whole body deadline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetched({ content: 'Body' })));
    await keenable.extract(url, { credentials: { proxy: 'http://proxy.example:8080' } });
    expect(proxyFetch).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), {
      proxy: 'http://proxy.example:8080',
      timeouts: { connectTimeout: 5000, headersTimeout: 30000, bodyTimeout: 30000 },
    });
  });
});
