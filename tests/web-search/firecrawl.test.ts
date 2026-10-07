import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithFirecrawl } from '@/lib/web-search/firecrawl';

describe('searchWithFirecrawl', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('requests search results without scraping and maps sources to single-line excerpts', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                title: 'OpenMAIC',
                url: 'https://github.com/THU-MAIC/OpenMAIC',
                description: '  ## OpenMAIC\n\nOpen multi-agent   interactive classroom.  ',
                position: 1,
              },
              {
                title: '',
                url: 'https://example.com/fallback',

                position: 2,
              },
              {
                title: 'Missing URL',
                description: 'This result is not auditable.',
              },
            ],
          },
          creditsUsed: 1,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithFirecrawl({
      query: '  OpenMAIC web search  ',
      apiKey: 'fc-key',
      maxResults: 5,
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/search',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer fc-key',
        },
        body: JSON.stringify({
          query: 'OpenMAIC web search',
          limit: 5,
          origin: 'openmaic',
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
          content: '## OpenMAIC Open multi-agent interactive classroom.',
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

  it('returns no sources when the response has no web results', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: {} }), { status: 200 }),
    );

    const result = await searchWithFirecrawl({ query: 'q', apiKey: 'key' });

    expect(result.sources).toEqual([]);
    expect(result.answer).toBe('');
  });

  it('normalizes endpoint URLs and bounds request inputs', async () => {
    proxyFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { web: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const longQuery = `  ${'x'.repeat(500)}  `;
    await searchWithFirecrawl({
      query: longQuery,
      apiKey: 'key',
      maxResults: 999,
      baseUrl: 'https://api.firecrawl.dev/',
    });
    await searchWithFirecrawl({
      query: 'q',
      apiKey: 'key',
      maxResults: 0,
      baseUrl: 'https://api.firecrawl.dev/v2/search',
    });
    await searchWithFirecrawl({
      query: 'q',
      apiKey: 'key',
      baseUrl: 'https://firecrawl.internal/v2',
    });

    expect(proxyFetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://api.firecrawl.dev/v2/search',
      'https://api.firecrawl.dev/v2/search',
      'https://firecrawl.internal/v2/search',
    ]);
    const firstBody = JSON.parse(proxyFetchMock.mock.calls[0][1].body as string);
    expect(firstBody.query).toHaveLength(400);
    expect(firstBody.limit).toBe(100);
    const secondBody = JSON.parse(proxyFetchMock.mock.calls[1][1].body as string);
    expect(secondBody.limit).toBe(1);
  });

  it('threads AbortSignal to the request', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 }),
    );
    const signal = new AbortController().signal;

    await searchWithFirecrawl({ query: 'q', apiKey: 'key', signal });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.firecrawl.dev/v2/search',
      expect.objectContaining({ signal }),
    );
  });

  it('throws on a non-OK response', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response('Insufficient credits', { status: 402, statusText: 'Payment Required' }),
    );

    await expect(searchWithFirecrawl({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'Firecrawl API error (402): Insufficient credits',
    );
  });
});
