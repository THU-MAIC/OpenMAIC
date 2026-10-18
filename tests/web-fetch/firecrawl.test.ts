import { afterEach, describe, expect, it, vi } from 'vitest';
import { firecrawl, firecrawlScrapeEndpoint } from '@/lib/web-fetch/providers/firecrawl';

const proxyFetch = vi.hoisted(() =>
  vi.fn((input: string | URL, init?: RequestInit, _options?: unknown) => fetch(input, init)),
);
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));

const url = 'https://example.com/page';
const scraped = (data: Record<string, unknown>) => Response.json({ success: true, data });
afterEach(() => vi.unstubAllGlobals());

describe('Firecrawl web fetch adapter', () => {
  it.each([
    ['https://api.firecrawl.dev', 'https://api.firecrawl.dev/v2/scrape'],
    ['https://api.firecrawl.dev/', 'https://api.firecrawl.dev/v2/scrape'],
    ['https://firecrawl.internal.example', 'https://firecrawl.internal.example/v2/scrape'],
    [
      'https://firecrawl.internal.example/v2/scrape',
      'https://firecrawl.internal.example/v2/scrape',
    ],
  ])('calls the scrape endpoint of %s', async (baseUrl, endpoint) => {
    const fetch = vi.fn().mockResolvedValue(
      scraped({
        markdown: '# Body',
        metadata: { title: 'Title', url: 'https://example.com/final', statusCode: 200 },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(await firecrawl.extract(url, { credentials: { apiKey: 'test-key', baseUrl } })).toEqual({
      markdown: '# Body',
      title: 'Title',
      finalUrl: 'https://example.com/final',
    });
    expect(fetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: 30_000,
      origin: 'openmaic',
    });
  });
  it('stops the scrape at the caller deadline', async () => {
    const fetch = vi.fn().mockResolvedValue(scraped({ markdown: 'Body' }));
    vi.stubGlobal('fetch', fetch);
    await firecrawl.extract(url, { credentials: { apiKey: 'test-key' }, bodyTimeoutMs: 12_000 });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ timeout: 12_000 });
  });
  it('reports the post-redirect url as the final URL, not the requested sourceURL', async () => {
    // Firecrawl's metadata: `url` is where the scrape ended up, `sourceURL` is what was requested.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        scraped({
          markdown: 'Body',
          metadata: { sourceURL: 'http://example.com/page', url: 'https://other.example/landed' },
        }),
      ),
    );
    expect(
      await firecrawl.extract('http://example.com/page', { credentials: { apiKey: 'test-key' } }),
    ).toEqual({ markdown: 'Body', finalUrl: 'https://other.example/landed' });
  });
  it('returns Markdown without optional metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(scraped({ markdown: 'Body' })));
    expect(await firecrawl.extract(url, { credentials: { apiKey: 'test-key' } })).toEqual({
      markdown: 'Body',
    });
  });
  it.each([404, 500])('reports an upstream HTTP %i like the builtin reader', async (statusCode) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(scraped({ markdown: 'Not found', metadata: { statusCode } })),
    );
    await expect(firecrawl.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
      `Remote server returned HTTP ${statusCode}`,
    );
  });
  it.each([401, 402, 403, 408, 429, 500, 502])(
    'maps HTTP %i without exposing the error body',
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ success: false, error: 'secret echoed by upstream' }, { status }),
        );
      vi.stubGlobal('fetch', fetch);
      const result = firecrawl.extract(url, { credentials: { apiKey: 'test-key' } });
      await expect(result).rejects.toThrow(`Web fetch provider returned HTTP ${status}`);
      await expect(result).rejects.not.toThrow(/secret/);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it('does not retry a transport failure, since the scrape may already be billed', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetch);
    await expect(firecrawl.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
      'fetch failed',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    {},
    { success: false, data: { markdown: 'Body' } },
    { success: true },
    { success: true, data: { markdown: 123 } },
    { success: true, data: { metadata: { title: 'No body' } } },
  ])('refuses invalid responses: %j', async (result) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(result)));
    await expect(firecrawl.extract(url, { credentials: { apiKey: 'test-key' } })).rejects.toThrow(
      /response/i,
    );
  });
  it('requires credentials before calling fetch', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(firecrawl.extract(url, {})).rejects.toThrow(/API key/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('defaults to the Firecrawl cloud API', () => {
    expect(firecrawl.resolveCredentials({ apiKey: 'test-key' })).toEqual({
      apiKey: 'test-key',
      baseUrl: 'https://api.firecrawl.dev',
    });
  });
  it('lets workspaces use only the official API base', () => {
    expect(firecrawl.acceptsWorkspaceBaseUrl?.('https://api.firecrawl.dev')).toBe(true);
    expect(firecrawl.acceptsWorkspaceBaseUrl?.('https://api.firecrawl.dev/')).toBe(true);
    expect(firecrawl.acceptsWorkspaceBaseUrl?.('https://firecrawl.internal.example')).toBe(false);
  });
  it.each([
    'https://api.firecrawl.dev?key=secret',
    'https://user:pass@api.firecrawl.dev',
    'https://api.firecrawl.dev#fragment',
  ])('refuses ambiguous API bases: %s', (base) => {
    expect(() => firecrawlScrapeEndpoint(base)).toThrow(/Invalid/);
    expect(firecrawl.acceptsWorkspaceBaseUrl?.(base)).toBe(false);
  });
  it('does not start an already aborted request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      firecrawl.extract(url, { credentials: { apiKey: 'test-key' }, signal: AbortSignal.abort() }),
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
    const result = firecrawl.extract(url, {
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
      firecrawl.extract(url, { credentials: { apiKey: 'test-key' }, bodyTimeoutMs: 20 }),
    ).rejects.toThrow(/aborted|Timed out/i);
  });
  it('bounds the JSON transport before parsing an oversized body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(scraped({ markdown: 'x'.repeat(70_000) })));
    await expect(
      firecrawl.extract(url, { credentials: { apiKey: 'test-key' }, maxBytes: 10 }),
    ).rejects.toThrow(/byte limit/);
  });
});

it('forwards an operator proxy and gives the scrape the whole body deadline', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(scraped({ markdown: 'Body' })));
  await firecrawl.extract(url, {
    credentials: { apiKey: 'test-key', proxy: 'http://proxy.example:8080' },
  });
  expect(proxyFetch).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), {
    proxy: 'http://proxy.example:8080',
    timeouts: { connectTimeout: 5000, headersTimeout: 30000, bodyTimeout: 30000 },
  });
});
