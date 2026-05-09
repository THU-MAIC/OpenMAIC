import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { searchWithBocha } from '@/lib/web-search/bocha';

describe('searchWithBocha', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('calls Bocha Web Search API and maps web page results', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 200,
          log_id: 'log-ok',
          msg: null,
          data: {
            queryContext: { originalQuery: '阿里巴巴 ESG' },
            webPages: {
              value: [
                {
                  name: 'Alibaba ESG report',
                  url: 'https://example.com/esg',
                  snippet: 'Short snippet',
                  summary: 'Long summary',
                },
                {
                  name: 'Snippet only',
                  url: 'https://example.com/snippet',
                  snippet: 'Fallback snippet',
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithBocha({
      query: '阿里巴巴 ESG',
      apiKey: 'bocha-key',
      maxResults: 100,
    });

    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.bocha.cn/v1/web-search',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer bocha-key',
        },
        body: JSON.stringify({
          query: '阿里巴巴 ESG',
          freshness: 'noLimit',
          summary: true,
          count: 50,
        }),
      }),
    );
    expect(result.query).toBe('阿里巴巴 ESG');
    expect(result.answer).toBe('');
    expect(result.sources).toEqual([
      {
        title: 'Alibaba ESG report',
        url: 'https://example.com/esg',
        content: 'Long summary',
        score: 0,
      },
      {
        title: 'Snippet only',
        url: 'https://example.com/snippet',
        content: 'Fallback snippet',
        score: 0,
      },
    ]);
  });

  it('supports custom base URLs ending at either host, /v1, or full endpoint', async () => {
    proxyFetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 200, data: { webPages: { value: [] } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await searchWithBocha({ query: 'q1', apiKey: 'key', baseUrl: 'https://proxy.example.com' });
    await searchWithBocha({ query: 'q2', apiKey: 'key', baseUrl: 'https://proxy.example.com/v1' });
    await searchWithBocha({
      query: 'q3',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/v1/web-search',
    });

    expect(proxyFetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://proxy.example.com/v1/web-search',
      'https://proxy.example.com/v1/web-search',
      'https://proxy.example.com/v1/web-search',
    ]);
  });

  it('includes Bocha error details when requests fail', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: '403',
          message: 'You do not have enough money',
          log_id: 'bocha-log-id',
        }),
        { status: 403, statusText: 'Forbidden', headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(searchWithBocha({ query: 'q', apiKey: 'key' })).rejects.toThrow(
      'Bocha API error (403): You do not have enough money, log_id: bocha-log-id',
    );
  });
});
