import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithDoubao } from '@/lib/web-search/doubao';

describe('searchWithDoubao', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('calls the Doubao search API and maps WebResults, preferring Summary', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ResponseMetadata: { RequestId: 'req-1' },
          Result: {
            ResultCount: 3,
            WebResults: [
              {
                Title: 'OpenMAIC',
                Url: 'https://github.com/THU-MAIC/OpenMAIC',
                Snippet: 'short blurb',
                Summary: 'a longer, query-relevant summary',
                Content: 'full article body',
                RankScore: 0.95,
              },
              {
                // No Summary → falls back to Content, then Snippet.
                Title: '',
                Url: 'https://example.com/fallback',
                Snippet: 'snippet only',
              },
              {
                // No Url → dropped.
                Title: 'No url',
                Summary: 'skipped because there is no url',
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithDoubao({
      query: 'OpenMAIC token plan',
      apiKey: 'ark-key',
      maxResults: 10,
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://open.feedcoopapi.com/search_api/web_search',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ark-key',
        },
        body: JSON.stringify({
          Query: 'OpenMAIC token plan',
          SearchType: 'web',
          Count: 10,
          NeedSummary: true,
        }),
      }),
    );
    expect(result.query).toBe('OpenMAIC token plan');
    expect(result.answer).toBe('');
    expect(result.sources).toEqual([
      {
        title: 'OpenMAIC',
        url: 'https://github.com/THU-MAIC/OpenMAIC',
        content: 'a longer, query-relevant summary',
        score: 0.95,
      },
      {
        title: 'https://example.com/fallback',
        url: 'https://example.com/fallback',
        content: 'snippet only',
        score: 0,
      },
    ]);
  });

  it('appends the search path when given a bare host base URL', async () => {
    proxyFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ Result: { WebResults: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await searchWithDoubao({ query: 'q', apiKey: 'k', baseUrl: 'https://proxy.example.com' });
    await searchWithDoubao({
      query: 'q',
      apiKey: 'k',
      baseUrl: 'https://proxy.example.com/search_api/web_search',
    });

    expect(proxyFetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://proxy.example.com/search_api/web_search',
      'https://proxy.example.com/search_api/web_search',
    ]);
  });

  it('caps Count at 50 and truncates the query to 100 chars', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Result: { WebResults: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const longQuery = 'x'.repeat(150);
    await searchWithDoubao({ query: longQuery, apiKey: 'k', maxResults: 999 });

    const body = JSON.parse(proxyFetchMock.mock.calls[0][1].body as string);
    expect(body.Query).toHaveLength(100);
    expect(body.Count).toBe(50);
  });

  it('throws with the Doubao error code/message when the body carries an Error', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ResponseMetadata: {
            Error: { CodeN: 10406, Code: '10406', Message: '免费搜索额度用尽' },
          },
          Result: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(searchWithDoubao({ query: 'q', apiKey: 'k' })).rejects.toThrow(
      'Doubao Web Search API error (10406): 免费搜索额度用尽',
    );
  });

  it('throws on a non-OK HTTP response', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response('nope', { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(searchWithDoubao({ query: 'q', apiKey: 'k' })).rejects.toThrow(
      'Doubao Web Search API error (500): nope',
    );
  });
});
