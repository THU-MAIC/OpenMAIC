import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { buildSearxngSearchUrl, searchWithSearxng } from '@/lib/web-search/searxng';

describe('buildSearxngSearchUrl', () => {
  it('builds JSON search URLs from instance root or /search base paths', () => {
    expect(buildSearxngSearchUrl('http://192.168.161.100:6060', 'hello')).toBe(
      'http://192.168.161.100:6060/search?q=hello&format=json',
    );
    expect(buildSearxngSearchUrl('http://192.168.161.100:6060/search', 'hello')).toBe(
      'http://192.168.161.100:6060/search?q=hello&format=json',
    );
  });
});

describe('searchWithSearxng', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('requires a configured base URL', async () => {
    await expect(searchWithSearxng({ query: 'test' })).rejects.toThrow(
      'SearXNG base URL is not configured',
    );
  });

  it('calls SearXNG JSON API and maps organic results', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          query: 'test query',
          results: [
            {
              title: 'First result',
              url: 'https://example.com/a',
              content: 'Snippet A',
              score: 3.1,
            },
            { title: 'Second result', url: 'https://example.com/b', content: 'Snippet B' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithSearxng({
      query: 'test query',
      baseUrl: 'http://192.168.161.100:6060',
      maxResults: 2,
    });

    const requestedUrl = new URL(proxyFetchMock.mock.calls[0][0] as string);
    expect(requestedUrl.origin).toBe('http://192.168.161.100:6060');
    expect(requestedUrl.pathname).toBe('/search');
    expect(requestedUrl.searchParams.get('q')).toBe('test query');
    expect(requestedUrl.searchParams.get('format')).toBe('json');
    expect(proxyFetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    expect(result.sources).toEqual([
      {
        title: 'First result',
        url: 'https://example.com/a',
        content: 'Snippet A',
        score: 3.1,
      },
      {
        title: 'Second result',
        url: 'https://example.com/b',
        content: 'Snippet B',
        score: 0.95,
      },
    ]);
    expect(result.query).toBe('test query');
  });
});
