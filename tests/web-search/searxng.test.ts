import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithSearXNG } from '@/lib/web-search/searxng';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const EMPTY_RESULT = { query: '', number_of_results: 0, results: [] };

describe('searchWithSearXNG', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('falls back to the default local base URL and requests the JSON API', async () => {
    proxyFetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_RESULT));

    await searchWithSearXNG({ query: 'hello' });

    const requestedUrl = new URL(proxyFetchMock.mock.calls[0][0]);
    expect(requestedUrl.origin).toBe('http://localhost:8888');
    expect(requestedUrl.pathname).toBe('/search');
    expect(requestedUrl.searchParams.get('q')).toBe('hello');
    expect(requestedUrl.searchParams.get('format')).toBe('json');
    expect(requestedUrl.searchParams.get('categories')).toBe('general');
  });

  it('does not double the /search suffix when the base URL already ends with it', async () => {
    proxyFetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_RESULT));

    await searchWithSearXNG({ query: 'hello', baseUrl: 'https://searx.example.com/search/' });

    const requestedUrl = new URL(proxyFetchMock.mock.calls[0][0]);
    expect(requestedUrl.pathname).toBe('/search');
  });

  it('sends a Bearer header only when an API key is provided', async () => {
    proxyFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(EMPTY_RESULT)));

    await searchWithSearXNG({ query: 'hello' });
    expect(proxyFetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');

    await searchWithSearXNG({ query: 'hello', apiKey: 'secret' });
    expect(proxyFetchMock.mock.calls[1][1].headers).toMatchObject({
      Authorization: 'Bearer secret',
    });
  });

  it('maps results, honors maxResults, and joins answers', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      jsonResponse({
        query: 'hello',
        number_of_results: 3,
        results: [
          { title: 'A', url: 'https://a.example.com', content: 'aaa', score: 1 },
          { title: 'B', url: 'https://b.example.com', content: 'bbb', score: 0.5 },
          { title: 'C', url: 'https://c.example.com', content: 'ccc', score: 0.2 },
        ],
        answers: ['first answer', 'second answer'],
      }),
    );

    const result = await searchWithSearXNG({ query: 'hello', maxResults: 2 });

    expect(result.sources).toEqual([
      { title: 'A', url: 'https://a.example.com', content: 'aaa', score: 1 },
      { title: 'B', url: 'https://b.example.com', content: 'bbb', score: 0.5 },
    ]);
    expect(result.answer).toBe('first answer\nsecond answer');
    expect(result.query).toBe('hello');
  });

  it('throws a descriptive error on a non-OK response', async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    await expect(searchWithSearXNG({ query: 'hello' })).rejects.toThrow(
      /SearXNG API error \(403\)/,
    );
  });
});
