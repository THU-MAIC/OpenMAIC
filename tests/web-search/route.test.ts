import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  searchWeb: vi.fn(),
  formatSearchResultsAsContext: vi.fn(() => 'formatted context'),
  resolveModelFromRequest: vi.fn(),
}));

vi.mock('@/lib/web-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/web-search')>();
  return {
    ...actual,
    searchWeb: mocks.searchWeb,
    formatSearchResultsAsContext: mocks.formatSearchResultsAsContext,
  };
});

vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));

vi.mock('@/lib/ai/llm', () => ({
  callLLM: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function postWebSearch(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/web-search/route');
  const request = new Request('http://localhost/api/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

describe('POST /api/web-search', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    delete process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_BASE_URL;
    delete process.env.BOCHA_API_KEY;
    delete process.env.BOCHA_BASE_URL;
    delete process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_BASE_URL;
    delete process.env.BAIDU_API_KEY;
    delete process.env.BAIDU_BASE_URL;
    delete process.env.WEB_SEARCH_MINIMAX_API_KEY;
    delete process.env.WEB_SEARCH_MINIMAX_BASE_URL;
    mocks.searchWeb.mockReset();
    mocks.formatSearchResultsAsContext.mockClear();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockRejectedValue(new Error('model unavailable'));
    mocks.searchWeb.mockResolvedValue({
      answer: '',
      sources: [],
      query: 'test query',
      responseTime: 0.1,
    });
  });

  it('rejects client-controlled base URLs outside the provider allowlist (unmanaged provider)', async () => {
    // No server config ⇒ unmanaged ⇒ the client base URL is actually used, so it
    // must be validated against the allowlist.
    const res = await postWebSearch({
      query: 'test query',
      providerId: 'bocha',
      apiKey: 'bocha-client-key',
      baseUrl: 'http://127.0.0.1:3000/internal',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.searchWeb).not.toHaveBeenCalled();
  });

  it('ignores a client base URL for a managed (server-configured) provider', async () => {
    vi.stubEnv('BOCHA_API_KEY', 'bocha-server-key');

    // A managed provider is admin-owned: the client base URL (even an invalid
    // one) is dropped rather than rejected, and the server config is used.
    const res = await postWebSearch({
      query: 'test query',
      providerId: 'bocha',
      apiKey: 'bocha-client-key',
      baseUrl: 'http://127.0.0.1:3000/internal',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'bocha',
        apiKey: 'bocha-server-key',
      }),
    );
  });

  it('uses server-configured base URL when no client base URL is supplied', async () => {
    vi.stubEnv('BOCHA_API_KEY', 'bocha-server-key');
    vi.stubEnv('BOCHA_BASE_URL', 'http://internal-proxy.local/bocha');

    const res = await postWebSearch({
      query: 'test query',
      providerId: 'bocha',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'bocha',
        apiKey: 'bocha-server-key',
        baseUrl: 'http://internal-proxy.local/bocha',
      }),
    );
  });

  it('runs Brave Search without an API key', async () => {
    const res = await postWebSearch({
      query: 'test query',
      providerId: 'brave',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'brave',
        apiKey: '',
      }),
    );
  });

  it('passes Baidu sub-source toggles through to the dispatcher', async () => {
    vi.stubEnv('BAIDU_API_KEY', 'baidu-server-key');

    const res = await postWebSearch({
      query: 'test query',
      providerId: 'baidu',
      baiduSubSources: {
        webSearch: false,
        baike: true,
        scholar: false,
      },
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'baidu',
        apiKey: 'baidu-server-key',
        baiduSubSources: {
          webSearch: false,
          baike: true,
          scholar: false,
        },
      }),
    );
  });

  it('routes MiniMax web search through the dispatcher with server config', async () => {
    vi.stubEnv('WEB_SEARCH_MINIMAX_API_KEY', 'minimax-server-key');
    vi.stubEnv('WEB_SEARCH_MINIMAX_BASE_URL', 'https://api.minimaxi.com');

    const res = await postWebSearch({
      query: 'test query',
      providerId: 'minimax',
    });

    expect(res.status).toBe(200);
    expect(mocks.searchWeb).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'minimax',
        apiKey: 'minimax-server-key',
        baseUrl: 'https://api.minimaxi.com',
      }),
    );
  });
});
