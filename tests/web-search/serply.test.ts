import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithSerply } from '@/lib/web-search/serply';

describe('searchWithSerply', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('sends the API key header and maps organic results to auditable sources', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'OpenMAIC',
              link: 'https://github.com/THU-MAIC/OpenMAIC',
              description: 'Open Multi-Agent Interactive Classroom.',
              position: 1,
            },
            {
              title: '',
              link: 'https://example.com/fallback',
              description: '',
            },
            {
              title: 'Missing link',
              description: 'This result is not auditable.',
            },
          ],
          total: 3,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithSerply({
      query: '  OpenMAIC web search  ',
      apiKey: 'serply-key',
      maxResults: 5,
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.serply.io/v1/search?q=OpenMAIC+web+search&num=5',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-Api-Key': 'serply-key',
        }),
      }),
    );
    expect(result).toMatchObject({
      answer: '',
      query: 'OpenMAIC web search',
      sources: [
        {
          title: 'OpenMAIC',
          url: 'https://github.com/THU-MAIC/OpenMAIC',
          content: 'Open Multi-Agent Interactive Classroom.',
          score: 1,
        },
        {
          title: 'https://example.com/fallback',
          url: 'https://example.com/fallback',
          content: '',
          score: 0.95,
        },
      ],
    });
  });

  it('normalizes endpoint URLs and bounds request inputs', async () => {
    proxyFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const longQuery = `  ${'x'.repeat(500)}  `;
    await searchWithSerply({
      query: longQuery,
      apiKey: 'key',
      maxResults: 999,
      baseUrl: 'https://api.serply.io/',
    });
    await searchWithSerply({
      query: 'q',
      apiKey: 'key',
      maxResults: 0,
      baseUrl: 'https://api.serply.io/v1/search',
    });

    const requestedUrls = proxyFetchMock.mock.calls.map((call) => new URL(call[0] as string));
    expect(requestedUrls.map((url) => `${url.origin}${url.pathname}`)).toEqual([
      'https://api.serply.io/v1/search',
      'https://api.serply.io/v1/search',
    ]);
    expect(requestedUrls[0].searchParams.get('q')).toHaveLength(400);
    expect(requestedUrls[0].searchParams.get('num')).toBe('100');
    expect(requestedUrls[1].searchParams.get('num')).toBe('1');
  });

  it('encodes reserved characters in the query string', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );

    await searchWithSerply({ query: 'C# 100% sure? #tag', apiKey: 'key' });

    const url = new URL(proxyFetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('q')).toBe('C# 100% sure? #tag');
  });

  it('threads AbortSignal to the request', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const signal = new AbortController().signal;

    await searchWithSerply({ query: 'q', apiKey: 'key', signal });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://api.serply.io/v1/search?'),
      expect.objectContaining({ signal }),
    );
  });

  it('throws on a non-OK response', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );

    await expect(searchWithSerply({ query: 'q', apiKey: 'bad' })).rejects.toThrow(
      'Serply API error (401): Unauthorized',
    );
  });
});
