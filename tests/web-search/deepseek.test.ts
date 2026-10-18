import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { searchWithDeepSeek } from '@/lib/web-search/deepseek';

const proxyFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch }));

beforeEach(() => {
  proxyFetch.mockReset();
  proxyFetch.mockResolvedValue(Response.json({ results: [] }));
});

describe('DeepSeek web search', () => {
  it.each([
    [undefined, 'https://api.deepseek.com/v1/tools/search'],
    ['https://api.deepseek.com/', 'https://api.deepseek.com/v1/tools/search'],
    ['https://api.deepseek.com/v1///', 'https://api.deepseek.com/v1/tools/search'],
    ['https://api.deepseek.com/beta', 'https://api.deepseek.com/v1/tools/search'],
    ['https://api.deepseek.com/beta/', 'https://api.deepseek.com/v1/tools/search'],
    ['https://api.deepseek.com/custom/prefix/v2', 'https://api.deepseek.com/v1/tools/search'],
    ['https://gateway.example/beta', 'https://gateway.example/beta/tools/search'],
    [
      'https://gateway.example/custom/prefix/v2',
      'https://gateway.example/custom/prefix/v2/tools/search',
    ],
    ['https://gateway.example/v1', 'https://gateway.example/v1/tools/search'],
    ['https://gateway.example/prefix/v1/', 'https://gateway.example/prefix/v1/tools/search'],
  ])('selects the endpoint for %s', async (baseUrl, endpoint) => {
    const signal = new AbortController().signal;
    const result = await searchWithDeepSeek({
      query: ' OpenMAIC ',
      apiKey: 'key',
      baseUrl,
      signal,
    });
    expect(proxyFetch).toHaveBeenCalledExactlyOnceWith(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'OpenMAIC', count: 10, need_content: false }),
      signal,
    });
    expect(result).toMatchObject({ query: 'OpenMAIC', sources: [], answer: '' });
    expect(result.responseTime).toBeGreaterThanOrEqual(0);
  });

  it('prefers summaries, falls back to snippets and filters missing URLs', async () => {
    proxyFetch.mockResolvedValueOnce(
      Response.json({
        results: [
          {
            title: 'Title',
            url: 'https://example.com',
            summary: 'Summary',
            snippet: 'Snippet',
            content: 'Body',
            rerank_score: 2.4,
          },
          { url: 'https://example.com/2', summary: '', snippet: 'Snippet' },
          { url: 'https://example.com/3', summary: '  ', snippet: 'Fallback' },
          { url: 'https://example.com/4' },
          { title: 'Missing URL' },
        ],
      }),
    );
    const result = await searchWithDeepSeek({ query: 'q', apiKey: 'key' });
    expect(result.sources).toEqual([
      { title: 'Title', url: 'https://example.com', content: 'Summary', score: 2.4 },
      {
        title: 'https://example.com/2',
        url: 'https://example.com/2',
        content: 'Snippet',
        score: 0,
      },
      {
        title: 'https://example.com/3',
        url: 'https://example.com/3',
        content: 'Fallback',
        score: 0,
      },
      { title: 'https://example.com/4', url: 'https://example.com/4', content: '', score: 0 },
    ]);
  });

  it.each(['a', '中', '😀'])('truncates %s by Unicode code point', async (character) => {
    const query = character.repeat(128);
    const result = await searchWithDeepSeek({ query: `  ${query}extra  `, apiKey: 'key' });
    expect(result.query).toBe(query);
    expect(JSON.parse(proxyFetch.mock.calls[0][1].body).query).toBe(query);
  });

  it.each([
    [2.9, 2],
    [0, 1],
    [-1, 1],
    [100, 50],
    [NaN, 10],
    [Infinity, 10],
  ])('bounds maxResults %s to %s and caps upstream results', async (maxResults, count) => {
    proxyFetch.mockResolvedValueOnce(
      Response.json({
        results: Array.from({ length: 60 }, () => ({ url: 'https://example.com' })),
      }),
    );
    const result = await searchWithDeepSeek({ query: 'q', apiKey: 'key', maxResults });
    expect(JSON.parse(proxyFetch.mock.calls[0][1].body).count).toBe(count);
    expect(result.sources).toHaveLength(count);
  });

  it('rejects an empty query before making a request', async () => {
    await expect(searchWithDeepSeek({ query: '  ', apiKey: 'key' })).rejects.toThrow(/nonempty/);
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 402, 403, 404, 408, 413, 429, 500, 504])(
    'reports HTTP %s without automatic HTTP retries, as Kimi does',
    async (status) => {
      proxyFetch.mockResolvedValueOnce(
        Response.json({ error: { message: 'Request refused' } }, { status }),
      );
      await expect(searchWithDeepSeek({ query: 'q', apiKey: 'key' })).rejects.toThrow(
        `DeepSeek Web Search API error (${status}): Request refused`,
      );
      expect(proxyFetch).toHaveBeenCalledTimes(1);
    },
  );

  it('reports non-JSON and empty error responses', async () => {
    for (const [body, statusText, expected] of [
      ['Unavailable', '', 'Unavailable'],
      ['', 'Unauthorized', 'Unauthorized'],
    ]) {
      proxyFetch.mockResolvedValueOnce(new Response(body, { status: 401, statusText }));
      await expect(searchWithDeepSeek({ query: 'q', apiKey: 'key' })).rejects.toThrow(expected);
    }
  });

  it('reports an error envelope in a successful HTTP response', async () => {
    proxyFetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'invalid_request', message: 'Bad query' } }),
    );
    await expect(searchWithDeepSeek({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      '(invalid_request): Bad query',
    );
  });

  it.each([null, {}, { results: null }, { results: {} }])(
    'rejects invalid results %j',
    async (body) => {
      proxyFetch.mockResolvedValueOnce(Response.json(body));
      await expect(searchWithDeepSeek({ query: 'q', apiKey: 'key' })).rejects.toThrow(
        /invalid results/,
      );
    },
  );

  it('propagates JSON, network and cancellation errors', async () => {
    proxyFetch.mockResolvedValueOnce(new Response('invalid'));
    await expect(searchWithDeepSeek({ query: 'q', apiKey: 'key' })).rejects.toThrow();
    for (const error of [
      new TypeError('fetch failed'),
      new DOMException('Cancelled', 'AbortError'),
    ]) {
      proxyFetch.mockRejectedValueOnce(error);
      await expect(searchWithDeepSeek({ query: 'q', apiKey: 'key' })).rejects.toBe(error);
    }
  });

  it('has a translated provider name everywhere Kimi is offered', () => {
    for (const file of readdirSync('lib/i18n/locales').filter((file) => file.endsWith('.json'))) {
      const locale = JSON.parse(readFileSync(`lib/i18n/locales/${file}`, 'utf8'));
      if (locale.settings.providerNames.kimi)
        expect(locale.settings.providerNames.deepseek, file).toBe('DeepSeek');
    }
  });
});
