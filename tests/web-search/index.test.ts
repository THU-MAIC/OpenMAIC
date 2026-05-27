import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchWithBochaMock = vi.hoisted(() => vi.fn());
const searchWithBraveMock = vi.hoisted(() => vi.fn());
const searchWithBaiduMock = vi.hoisted(() => vi.fn());
const searchWithTavilyMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/web-search/bocha', () => ({
  searchWithBocha: searchWithBochaMock,
}));

vi.mock('@/lib/web-search/brave', () => ({
  searchWithBrave: searchWithBraveMock,
}));

vi.mock('@/lib/web-search/baidu', () => ({
  searchWithBaidu: searchWithBaiduMock,
}));

vi.mock('@/lib/web-search/tavily', () => ({
  searchWithTavily: searchWithTavilyMock,
}));

import { searchWeb } from '@/lib/web-search';

describe('searchWeb', () => {
  beforeEach(() => {
    searchWithBochaMock.mockReset();
    searchWithBraveMock.mockReset();
    searchWithBaiduMock.mockReset();
    searchWithTavilyMock.mockReset();
  });

  it('dispatches Tavily provider requests', async () => {
    searchWithTavilyMock.mockResolvedValueOnce({
      answer: 'tavily answer',
      sources: [],
      query: 'q',
      responseTime: 0.1,
    });

    await expect(searchWeb({ providerId: 'tavily', query: 'q', apiKey: 'key' })).resolves.toEqual({
      answer: 'tavily answer',
      sources: [],
      query: 'q',
      responseTime: 0.1,
    });
    expect(searchWithTavilyMock).toHaveBeenCalledWith({
      query: 'q',
      apiKey: 'key',
      maxResults: undefined,
      baseUrl: undefined,
    });
    expect(searchWithBochaMock).not.toHaveBeenCalled();
  });

  it('dispatches Bocha provider requests', async () => {
    searchWithBochaMock.mockResolvedValueOnce({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.2,
    });

    await expect(
      searchWeb({
        providerId: 'bocha',
        query: 'q',
        apiKey: 'key',
        maxResults: 20,
        baseUrl: 'https://api.bocha.cn',
      }),
    ).resolves.toEqual({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.2,
    });
    expect(searchWithBochaMock).toHaveBeenCalledWith({
      query: 'q',
      apiKey: 'key',
      maxResults: 20,
      baseUrl: 'https://api.bocha.cn',
    });
    expect(searchWithTavilyMock).not.toHaveBeenCalled();
  });

  it('dispatches Brave provider requests without an API key', async () => {
    searchWithBraveMock.mockResolvedValueOnce({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.3,
    });

    await expect(searchWeb({ providerId: 'brave', query: 'q' })).resolves.toEqual({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.3,
    });
    expect(searchWithBraveMock).toHaveBeenCalledWith({
      query: 'q',
      maxResults: undefined,
      baseUrl: undefined,
    });
  });

  it('dispatches Baidu provider requests with sub-source toggles', async () => {
    searchWithBaiduMock.mockResolvedValueOnce({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.4,
    });

    await expect(
      searchWeb({
        providerId: 'baidu',
        query: 'q',
        apiKey: 'baidu-key',
        baiduSubSources: { webSearch: false, baike: true, scholar: false },
      }),
    ).resolves.toEqual({
      answer: '',
      sources: [],
      query: 'q',
      responseTime: 0.4,
    });
    expect(searchWithBaiduMock).toHaveBeenCalledWith({
      query: 'q',
      apiKey: 'baidu-key',
      maxResults: undefined,
      baseUrl: undefined,
      subSources: { webSearch: false, baike: true, scholar: false },
    });
  });
});
