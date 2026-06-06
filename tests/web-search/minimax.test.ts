import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithMiniMax } from '@/lib/web-search/minimax';

describe('searchWithMiniMax', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('calls MiniMax Web Search API and maps organic results', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          organic: [
            {
              title: 'OpenMAIC',
              link: 'https://github.com/THU-MAIC/OpenMAIC',
              snippet: 'OpenMAIC project repository.',
              date: '2026-05-31',
            },
            {
              title: '',
              link: 'https://example.com/fallback',
              snippet: '',
              date: '2026-05-30',
            },
            {
              title: 'No link',
              snippet: 'Skipped because MiniMax did not return a URL.',
            },
          ],
          base_resp: { status_code: 0, status_msg: 'success' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithMiniMax({
      query: 'MiniMax Token Plan',
      apiKey: 'minimax-key',
      maxResults: 10,
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.minimaxi.com/v1/coding_plan/search',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer minimax-key',
          'MM-API-Source': 'OpenMAIC',
        },
        body: JSON.stringify({ q: 'MiniMax Token Plan' }),
      }),
    );
    expect(result.query).toBe('MiniMax Token Plan');
    expect(result.answer).toBe('');
    expect(result.sources).toEqual([
      {
        title: 'OpenMAIC',
        url: 'https://github.com/THU-MAIC/OpenMAIC',
        content: 'OpenMAIC project repository.',
        score: 0,
      },
      {
        title: 'https://example.com/fallback',
        url: 'https://example.com/fallback',
        content: '2026-05-30',
        score: 0,
      },
    ]);
  });

  it('supports custom base URLs ending at host, /v1, /v1/coding_plan, or full endpoint', async () => {
    proxyFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ organic: [], base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await searchWithMiniMax({ query: 'q1', apiKey: 'key', baseUrl: 'https://proxy.example.com' });
    await searchWithMiniMax({
      query: 'q2',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/v1',
    });
    await searchWithMiniMax({
      query: 'q3',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/v1/coding_plan',
    });
    await searchWithMiniMax({
      query: 'q4',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/v1/coding_plan/search',
    });

    expect(proxyFetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://proxy.example.com/v1/coding_plan/search',
      'https://proxy.example.com/v1/coding_plan/search',
      'https://proxy.example.com/v1/coding_plan/search',
      'https://proxy.example.com/v1/coding_plan/search',
    ]);
  });

  it('includes MiniMax error details when requests fail', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          base_resp: {
            status_code: 1001,
            status_msg: 'invalid api key',
          },
        }),
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(searchWithMiniMax({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'MiniMax Web Search API error (1001): invalid api key',
    );
  });
});
