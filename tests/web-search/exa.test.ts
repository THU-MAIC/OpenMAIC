import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithExa } from '@/lib/web-search/exa';

describe('searchWithExa', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('requests highlighted contents and maps auditable sources', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          requestId: 'req-1',
          results: [
            {
              title: 'OpenMAIC',
              url: 'https://github.com/THU-MAIC/OpenMAIC',
              highlights: ['First relevant excerpt.', 'Second relevant excerpt.'],
              score: 0.94,
            },
            {
              title: '',
              id: 'https://example.com/fallback',
              highlights: [],
              summary: 'Summary fallback',
            },
            {
              title: 'Missing URL',
              highlights: ['This result is not auditable.'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithExa({
      query: '  OpenMAIC web search  ',
      apiKey: 'exa-key',
      maxResults: 5,
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.exa.ai/search',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer exa-key',
        },
        body: JSON.stringify({
          query: 'OpenMAIC web search',
          type: 'auto',
          numResults: 5,
          contents: { highlights: true },
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
          content: 'First relevant excerpt.\n\nSecond relevant excerpt.',
          score: 0.94,
        },
        {
          title: 'https://example.com/fallback',
          url: 'https://example.com/fallback',
          content: 'Summary fallback',
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
    await searchWithExa({
      query: longQuery,
      apiKey: 'key',
      maxResults: 999,
      baseUrl: 'https://api.exa.ai/',
    });
    await searchWithExa({
      query: 'q',
      apiKey: 'key',
      baseUrl: 'https://api.exa.ai/search',
    });

    expect(proxyFetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://api.exa.ai/search',
      'https://api.exa.ai/search',
    ]);
    const body = JSON.parse(proxyFetchMock.mock.calls[0][1].body as string);
    expect(body.query).toHaveLength(400);
    expect(body.numResults).toBe(100);
  });

  it('threads AbortSignal to the request', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const signal = new AbortController().signal;

    await searchWithExa({ query: 'q', apiKey: 'key', signal });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.exa.ai/search',
      expect.objectContaining({ signal }),
    );
  });

  it('throws on a non-OK response', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response('credits exhausted', { status: 402, statusText: 'Payment Required' }),
    );

    await expect(searchWithExa({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'Exa API error (402): credits exhausted',
    );
  });
});
