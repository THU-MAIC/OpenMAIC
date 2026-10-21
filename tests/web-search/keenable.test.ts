import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithKeenable } from '@/lib/web-search/keenable';

const emptyResponse = () =>
  Promise.resolve(
    new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

describe('searchWithKeenable', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('searches the public endpoint without a key and maps snippets to single-line excerpts', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Photosynthesis',
              url: 'https://example.com/photosynthesis',
              description: '',
              snippet: '  **Quick summary:** light reactions\n\noccur in the   thylakoid.  ',
              acquired_at: '2026-09-23T07:44:22Z',
            },
            {
              title: '',
              url: 'https://example.com/fallback',
              description: '',
            },
            {
              title: 'Missing URL',
              snippet: 'This result is not auditable.',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithKeenable({
      query: '  photosynthesis light reactions  ',
      maxResults: 5,
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.keenable.ai/v1/search/public',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Keenable-Title': 'OpenMAIC',
        },
        body: JSON.stringify({ query: 'photosynthesis light reactions', max_results: 5 }),
      }),
    );
    expect(result).toMatchObject({
      answer: '',
      query: 'photosynthesis light reactions',
      sources: [
        {
          title: 'Photosynthesis',
          url: 'https://example.com/photosynthesis',
          content: '**Quick summary:** light reactions occur in the thylakoid.',
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

  it('sends an optional key to the keyed endpoint', async () => {
    proxyFetchMock.mockImplementation(emptyResponse);

    await searchWithKeenable({ query: 'q', apiKey: 'kn-key' });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.keenable.ai/v1/search',
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'X-Keenable-Title': 'OpenMAIC',
          'X-API-Key': 'kn-key',
        },
      }),
    );
  });

  it('returns no sources when the response has no results', async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const result = await searchWithKeenable({ query: 'q' });

    expect(result.sources).toEqual([]);
    expect(result.answer).toBe('');
  });

  it('normalizes endpoint URLs and bounds request inputs', async () => {
    proxyFetchMock.mockImplementation(emptyResponse);

    await searchWithKeenable({
      query: `  ${'x'.repeat(500)}  `,
      maxResults: 999,
      baseUrl: 'https://api.keenable.ai/',
    });
    await searchWithKeenable({
      query: 'q',
      maxResults: 0,
      baseUrl: 'https://api.keenable.ai/v1/search/public',
    });
    await searchWithKeenable({
      query: 'q',
      apiKey: 'kn-key',
      baseUrl: 'https://keenable.internal/v1',
    });

    expect(proxyFetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://api.keenable.ai/v1/search/public',
      'https://api.keenable.ai/v1/search/public',
      'https://keenable.internal/v1/search',
    ]);
    const firstBody = JSON.parse(proxyFetchMock.mock.calls[0][1].body as string);
    expect(firstBody.query).toHaveLength(400);
    expect(firstBody.max_results).toBe(50);
    const secondBody = JSON.parse(proxyFetchMock.mock.calls[1][1].body as string);
    expect(secondBody.max_results).toBe(1);
  });

  it('threads AbortSignal to the request', async () => {
    proxyFetchMock.mockImplementation(emptyResponse);
    const signal = new AbortController().signal;

    await searchWithKeenable({ query: 'q', signal });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.keenable.ai/v1/search/public',
      expect.objectContaining({ signal }),
    );
  });

  it('throws on a non-OK response without relaying the vendor message', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response('Invalid key: kn-secret-echo', { status: 401, statusText: 'Unauthorized' }),
    );

    const error = await searchWithKeenable({ query: 'q', apiKey: 'key' }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Keenable API error (HTTP 401)');
    expect(error.message).not.toContain('kn-secret-echo');
  });

  it('falls back to the default limit for a non-finite maxResults', async () => {
    proxyFetchMock.mockImplementation(emptyResponse);
    await searchWithKeenable({ query: 'q', maxResults: Number.NaN });
    expect(JSON.parse(proxyFetchMock.mock.calls[0][1].body as string).max_results).toBe(5);
  });
});
