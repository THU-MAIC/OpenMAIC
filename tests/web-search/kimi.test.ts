import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: proxyFetchMock }));

import { searchWithKimi } from '@/lib/web-search/kimi';

const repository = 'https://github.com/THU-MAIC/OpenMAIC';

beforeEach(() => {
  proxyFetchMock.mockReset();
  proxyFetchMock.mockImplementation(async () => Response.json({ search_results: [] }));
});

describe('Kimi web search', () => {
  it.each([
    [undefined, 'https://api.moonshot.cn/v1/tools/search_pro', false],
    ['https://api.moonshot.cn/v1/', 'https://api.moonshot.cn/v1/tools/search_pro', false],
    ['https://api.moonshot.ai/v1', 'https://api.moonshot.ai/v1/tools/search_pro', false],
    ['https://api.kimi.com/coding/v1', 'https://api.kimi.com/coding/v1/search', true],
    ['https://api.kimi.ai/coding/v1///', 'https://api.kimi.ai/coding/v1/search', true],
    [
      'https://search.openmaic.test/coding/v1',
      'https://search.openmaic.test/coding/v1/search',
      true,
    ],
    ['https://search.openmaic.test/v1', 'https://search.openmaic.test/v1/tools/search_pro', false],
  ])('selects the endpoint for %s', async (baseUrl, endpoint, coding) => {
    const signal = new AbortController().signal;
    const result = await searchWithKimi({
      query: 'OpenMAIC',
      apiKey: 'key',
      baseUrl,
      maxResults: 3,
      signal,
    });
    expect(proxyFetchMock).toHaveBeenCalledWith(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key' },
      body: JSON.stringify({
        text_query: 'OpenMAIC',
        limit: 3,
        timeout_seconds: 30,
        ...(coding ? { enable_page_crawling: true } : {}),
      }),
      signal,
    });
    expect(result).toMatchObject({ answer: '', sources: [], query: 'OpenMAIC' });
    expect(result.responseTime).toBeGreaterThanOrEqual(0);
  });

  it('joins nonempty Open Platform chunks and falls back to snippets', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      Response.json({
        search_results: [
          {
            title: 'OpenMAIC',
            url: repository,
            snippet: 'Summary',
            chunks: [
              { text: 'First page chunk' },
              { text: '' },
              {},
              { text: '  ' },
              { text: 'Second page chunk' },
            ],
            date: '2026-10-13',
            site_name: 'OpenMAIC',
          },
          { url: repository + '/issues', snippet: 'Issues', chunks: [] },
          { url: repository + '/pulls', snippet: 'Pull requests' },
          { title: 'Missing URL', snippet: 'Skipped' },
        ],
      }),
    );
    const result = await searchWithKimi({ query: 'OpenMAIC', apiKey: 'key' });
    expect(result.sources).toEqual([
      {
        title: 'OpenMAIC',
        url: repository,
        content: 'First page chunk\n\nSecond page chunk',
        score: 0,
      },
      { title: repository + '/issues', url: repository + '/issues', content: 'Issues', score: 0 },
      {
        title: repository + '/pulls',
        url: repository + '/pulls',
        content: 'Pull requests',
        score: 0,
      },
    ]);
  });

  it('prefers Coding Plan page content, then snippet, then empty text', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      Response.json({
        search_results: [
          { title: 'OpenMAIC', url: repository, content: 'Full page', snippet: 'Summary' },
          { url: repository + '/issues', content: '', snippet: 'Issues' },
          { url: repository + '/pulls' },
        ],
      }),
    );
    const result = await searchWithKimi({
      query: 'q',
      apiKey: 'key',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
    expect(result.sources.map((source) => source.content)).toEqual(['Full page', 'Issues', '']);
  });

  it.each(['https://api.moonshot.cn/v1', 'https://api.kimi.com/coding/v1'])(
    'keeps only the requested three results when %s returns nineteen',
    async (baseUrl) => {
      const items = Array.from({ length: 19 }, (_, index) => ({
        content: `Page content ${index}`,
        chunks: [{ text: `Page chunk ${index}` }],
        date: '2026-10-14',
        icon: '',
        mime: 'text/html',
        site_name: 'OpenMAIC',
        snippet: `Summary ${index}`,
        title: `Result ${index}`,
        url: `${repository}/issues/${index + 1}`,
      }));
      proxyFetchMock.mockResolvedValueOnce(Response.json({ search_results: items }));
      const result = await searchWithKimi({
        query: 'OpenMAIC',
        apiKey: 'key',
        baseUrl,
        maxResults: 3,
      });
      expect(JSON.parse(proxyFetchMock.mock.calls[0][1].body).limit).toBe(3);
      expect(result.sources).toHaveLength(3);
      expect(result.sources.map((source) => source.url)).toEqual(
        items.slice(0, 3).map((item) => item.url),
      );
      expect(result.sources[0].content).toBe(
        baseUrl.includes('/coding/v1') ? 'Page content 0' : 'Page chunk 0',
      );
    },
  );

  it.each([
    [2.9, 2],
    [0, 1],
    [-1, 1],
    [100, 20],
    [NaN, 10],
    [Infinity, 10],
  ])('bounds maxResults %s to %s', async (maxResults, limit) => {
    proxyFetchMock.mockResolvedValueOnce(
      Response.json({ search_results: Array.from({ length: 25 }, () => ({ url: repository })) }),
    );
    const result = await searchWithKimi({ query: 'q', apiKey: 'key', maxResults });
    expect(JSON.parse(proxyFetchMock.mock.calls[0][1].body).limit).toBe(limit);
    expect(result.sources).toHaveLength(limit);
  });

  it('uses the shared query normalization and 400-character limit', async () => {
    const result = await searchWithKimi({ query: '  ' + 'q'.repeat(450), apiKey: 'key' });
    expect(result.query).toBe('q'.repeat(400));
    expect(JSON.parse(proxyFetchMock.mock.calls[0][1].body).text_query).toBe(result.query);
  });

  it.each([401, 403, 429, 500, 504])(
    'reports HTTP %s with the provider message',
    async (status) => {
      proxyFetchMock.mockResolvedValueOnce(
        Response.json({ error: { message: 'Request refused' } }, { status }),
      );
      await expect(searchWithKimi({ query: 'q', apiKey: 'key' })).rejects.toThrow(
        `Kimi Web Search API error (${status}): Request refused`,
      );
    },
  );

  it('reports a non-JSON error', async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response('Service unavailable', { status: 502 }));
    await expect(searchWithKimi({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'Kimi Web Search API error (502): Service unavailable',
    );
  });

  it('uses the status text for an empty error body', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response('', { status: 401, statusText: 'Unauthorized' }),
    );
    await expect(searchWithKimi({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'Kimi Web Search API error (401): Unauthorized',
    );
  });

  it('reports an error envelope even if HTTP status is 200', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: 'invalid_request', message: 'Bad query' } }),
    );
    await expect(searchWithKimi({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'Kimi Web Search API error (invalid_request): Bad query',
    );
  });

  it.each([{}, { search_results: null }, { search_results: {} }])(
    'rejects a malformed response %j',
    async (body) => {
      proxyFetchMock.mockResolvedValueOnce(Response.json(body));
      await expect(searchWithKimi({ query: 'q', apiKey: 'key' })).rejects.toThrow(
        'invalid search_results field',
      );
    },
  );

  it('propagates invalid JSON, network errors and cancellation', async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response('invalid JSON'));
    await expect(searchWithKimi({ query: 'q', apiKey: 'key' })).rejects.toThrow();
    for (const error of [
      new Error('Network failed'),
      new DOMException('Cancelled', 'AbortError'),
    ]) {
      proxyFetchMock.mockRejectedValueOnce(error);
      await expect(
        searchWithKimi({ query: 'q', apiKey: 'key', signal: AbortSignal.abort() }),
      ).rejects.toBe(error);
    }
  });
});
