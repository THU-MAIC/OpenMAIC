import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { searchWithBaidu } from '@/lib/web-search/baidu';

describe('searchWithBaidu', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset();
  });

  it('queries only enabled Baidu sub-sources and merges their results', async () => {
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errno: 0,
          result: {
            lemma_title: 'OpenMAIC',
            lemma_url: 'https://baike.baidu.com/item/OpenMAIC',
            abstract_text: 'Baidu Baike abstract',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    proxyFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: '0',
          data: [
            {
              title: 'OpenMAIC paper',
              abstract: 'Scholar abstract',
              aiAbstract: 'Scholar AI abstract',
              url: 'https://xueshu.baidu.com/usercenter/paper/show?paperid=1',
              publishYear: 2026,
              keyword: 'AI education',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await searchWithBaidu({
      query: 'OpenMAIC',
      apiKey: 'baidu-key',
      subSources: {
        webSearch: false,
        baike: true,
        scholar: true,
      },
    });

    expect(proxyFetchMock).toHaveBeenCalledTimes(2);
    expect(proxyFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://appbuilder.baidu.com/v2/baike/lemma/get_content?search_type=lemmaTitle&search_key=OpenMAIC',
      'https://qianfan.baidubce.com/v2/tools/baidu_scholar/search?wd=OpenMAIC&pageNum=0&enable_ai_abstract=true',
    ]);
    expect(result.sources.map((source) => source.title)).toEqual([
      'OpenMAIC - Baidu Baike',
      'OpenMAIC paper',
    ]);
    expect(result.sources[1]?.content).toBe(
      'Scholar abstract Scholar AI abstract (2026) AI education',
    );
  });

  it('defaults Baidu sub-sources to all enabled when omitted', async () => {
    proxyFetchMock.mockImplementation((url: string) => {
      if (url.includes('/ai_search/web_search')) {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 0, references: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      if (url.includes('/baike/lemma/get_content')) {
        return Promise.resolve(
          new Response(JSON.stringify({ errno: 0 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ code: '0', data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    await searchWithBaidu({ query: 'OpenMAIC', apiKey: 'baidu-key' });

    expect(proxyFetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      'https://qianfan.baidubce.com/v2/ai_search/web_search',
      'https://appbuilder.baidu.com/v2/baike/lemma/get_content?search_type=lemmaTitle&search_key=OpenMAIC',
      'https://qianfan.baidubce.com/v2/tools/baidu_scholar/search?wd=OpenMAIC&pageNum=0&enable_ai_abstract=true',
    ]);
  });
});
