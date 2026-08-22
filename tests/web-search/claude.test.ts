import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── AI SDK mocks ──────────────────────────────────────────────────────────────

const { mockGenerateText, mockProvider, mockTool, mockCreateAnthropic } = vi.hoisted(() => {
  const mockTool = {};
  const mockModel = {};
  const mockProvider = Object.assign(
    vi.fn(() => mockModel),
    {
      tools: {
        webSearch_20260209: vi.fn(() => mockTool),
        webSearch_20250305: vi.fn(() => mockTool),
      },
    },
  );
  const mockCreateAnthropic = vi.fn(() => mockProvider);
  const mockGenerateText = vi.fn();
  return { mockGenerateText, mockProvider, mockTool, mockCreateAnthropic };
});

vi.mock('@/lib/ai/llm', () => ({ callLLM: mockGenerateText }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mockCreateAnthropic }));
vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { searchWithClaude } from '@/lib/web-search/claude';
import { CLAUDE_WEB_SEARCH_DEFAULT_MODEL } from '@/lib/web-search/constants';

const mockProxyFetch = proxyFetch as ReturnType<typeof vi.fn>;

type UrlSource = { sourceType: 'url'; type: 'source'; id: string; url: string; title?: string };

function urlSource(url: string, title?: string, id = 'src-1'): UrlSource {
  return { sourceType: 'url', type: 'source', id, url, title };
}

function mockAIResponse(text = 'Search result', sources: UrlSource[] = []) {
  mockGenerateText.mockResolvedValueOnce({ text, sources });
}

function getWrappedFetch(): (url: string, init?: RequestInit) => Promise<Response> {
  const calls = mockCreateAnthropic.mock.calls as unknown as [options: Record<string, unknown>][];
  return calls[0]![0]!['fetch'] as (url: string, init?: RequestInit) => Promise<Response>;
}

describe('searchWithClaude', () => {
  beforeEach(() => {
    mockProxyFetch.mockReset();
    mockGenerateText.mockReset();
    mockCreateAnthropic.mockClear();
    mockProvider.mockClear();
    mockProvider.tools.webSearch_20260209.mockClear();
    mockProvider.tools.webSearch_20250305.mockClear();
  });

  it('passes the caller signal to the underlying AI SDK request', async () => {
    const signal = new AbortController().signal;
    mockAIResponse();

    await searchWithClaude({ query: 'test', apiKey: 'sk-test', signal });

    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: signal }),
      'web-search-claude',
    );
  });

  // ── fetch interceptor: allowed_callers injection ──────────────────────────

  it('injects allowed_callers=["direct"] on the basic tool (Haiku 4.5 request body)', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', modelId: 'claude-haiku-4-5' });

    const wrappedFetch = getWrappedFetch();
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    });
    mockProxyFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await wrappedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });

    const proxyCalls = mockProxyFetch.mock.calls as unknown as [string, RequestInit][];
    const sentBody = JSON.parse(proxyCalls[0]![1]!.body as string);
    expect(sentBody.tools[0].allowed_callers).toEqual(['direct']);
  });

  it('leaves the dynamic-filtering tool unpinned (Sonnet 5 request body)', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', modelId: 'claude-sonnet-5' });

    const wrappedFetch = getWrappedFetch();
    const body = JSON.stringify({
      model: 'claude-sonnet-5',
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    });
    mockProxyFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await wrappedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });

    const proxyCalls = mockProxyFetch.mock.calls as unknown as [string, RequestInit][];
    // Untouched body: pinning to "direct" would bypass the code-execution
    // caller that provides dynamic filtering.
    expect(proxyCalls[0]![1]!.body).toBe(body);
    const sentBody = JSON.parse(proxyCalls[0]![1]!.body as string);
    expect(sentBody.tools[0].allowed_callers).toBeUndefined();
  });

  it('does not overwrite allowed_callers when already set', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', modelId: 'claude-haiku-4-5' });

    const wrappedFetch = getWrappedFetch();
    const body = JSON.stringify({
      tools: [{ type: 'web_search_20250305', name: 'web_search', allowed_callers: ['code'] }],
    });
    mockProxyFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await wrappedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });

    const proxyCalls = mockProxyFetch.mock.calls as unknown as [string, RequestInit][];
    const sentBody = JSON.parse(proxyCalls[0]![1]!.body as string);
    expect(sentBody.tools[0].allowed_callers).toEqual(['code']);
  });

  it('leaves requests without a tools array untouched', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test' });

    const wrappedFetch = getWrappedFetch();
    const body = JSON.stringify({ model: 'claude-sonnet-5' });
    mockProxyFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await wrappedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });

    const proxyCalls = mockProxyFetch.mock.calls as unknown as [string, RequestInit][];
    expect(proxyCalls[0]![1]!.body).toBe(body);
  });

  it('leaves non-JSON POST bodies unchanged', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test' });

    const wrappedFetch = getWrappedFetch();
    mockProxyFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await wrappedFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: 'not json',
    });

    const proxyCalls = mockProxyFetch.mock.calls as unknown as [string, RequestInit][];
    expect(proxyCalls[0]![1]!.body).toBe('not json');
  });

  // ── model + tool selection ─────────────────────────────────────────────────

  it('uses the default model when none is given', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test' });
    expect(mockProvider).toHaveBeenCalledWith(CLAUDE_WEB_SEARCH_DEFAULT_MODEL);
  });

  it('uses the provided model, trimmed', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', modelId: '  claude-opus-5  ' });
    expect(mockProvider).toHaveBeenCalledWith('claude-opus-5');
  });

  it('falls back to the default model for a blank modelId', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', modelId: '   ' });
    expect(mockProvider).toHaveBeenCalledWith(CLAUDE_WEB_SEARCH_DEFAULT_MODEL);
  });

  it.each([
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
  ])('uses web_search_20260209 for %s', async (modelId) => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', modelId });
    expect(mockProvider.tools.webSearch_20260209).toHaveBeenCalled();
    expect(mockProvider.tools.webSearch_20250305).not.toHaveBeenCalled();
  });

  it.each([
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5-20251101',
    'claude-opus-4-1',
    // Canonical dated Claude 4.0 ids — pre-4.6, so basic search only.
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-3-5-sonnet-20241022',
    'not-a-claude-model',
  ])('uses the basic web_search_20250305 for %s', async (modelId) => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', modelId });
    expect(mockProvider.tools.webSearch_20250305).toHaveBeenCalled();
    expect(mockProvider.tools.webSearch_20260209).not.toHaveBeenCalled();
  });

  it('maps maxResults to the tool maxUses argument', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', maxResults: 3 });
    expect(mockProvider.tools.webSearch_20260209).toHaveBeenCalledWith({ maxUses: 3 });
  });

  it('omits maxUses when maxResults is not given', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test' });
    expect(mockProvider.tools.webSearch_20260209).toHaveBeenCalledWith({});
  });

  it('passes the web search tool through callLLM with a usage source label', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test' });
    const [args, source] = mockGenerateText.mock.calls[0]! as [
      { tools: Record<string, unknown> },
      string,
    ];
    expect(args.tools).toEqual({ web_search: mockTool });
    expect(source).toBe('web-search-claude');
  });

  // ── provider configuration ────────────────────────────────────────────────

  it('defaults the base URL to the Anthropic API', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test' });
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test', baseURL: 'https://api.anthropic.com/v1' }),
    );
  });

  it('trims whitespace around a pasted API key and base URL', async () => {
    mockAIResponse();
    await searchWithClaude({
      query: 'test',
      apiKey: '  sk-test\n',
      baseUrl: '  https://api.anthropic.com/v1  ',
    });
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-test', baseURL: 'https://api.anthropic.com/v1' }),
    );
  });

  it('strips trailing slashes from a custom base URL', async () => {
    mockAIResponse();
    await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com/v1/',
    });
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.anthropic.com/v1' }),
    );
  });

  // The allowlist and Settings both accept the bare Anthropic root, but the AI
  // SDK appends "/messages" verbatim — without /v1 the request 404s.
  it.each([
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    '  https://api.anthropic.com  ',
  ])('normalizes the bare Anthropic root (%s) so the request URL keeps /v1', async (baseUrl) => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', baseUrl });

    const calls = mockCreateAnthropic.mock.calls as unknown as [{ baseURL: string }][];
    const { baseURL } = calls[0]![0]!;
    expect(baseURL).toBe('https://api.anthropic.com/v1');
    expect(`${baseURL}/messages`).toBe('https://api.anthropic.com/v1/messages');
  });

  it('leaves a self-hosted gateway base URL untouched', async () => {
    mockAIResponse();
    await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://gateway.internal.example.com/anthropic',
    });
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://gateway.internal.example.com/anthropic' }),
    );
  });

  // ── result mapping ─────────────────────────────────────────────────────────

  it('returns the answer and cited sources without fetching pages', async () => {
    mockAIResponse('Node.js 22 is the current LTS.', [
      urlSource('https://nodejs.org/en', 'Node.js', 'a'),
      urlSource('https://endoflife.date/nodejs', 'endoflife.date', 'b'),
    ]);

    const result = await searchWithClaude({ query: 'node lts', apiKey: 'sk-test' });

    expect(result.answer).toBe('Node.js 22 is the current LTS.');
    expect(result.query).toBe('node lts');
    expect(typeof result.responseTime).toBe('number');
    expect(result.sources).toEqual([
      {
        title: 'Node.js',
        url: 'https://nodejs.org/en',
        content: 'Referenced by the Claude web-search answer.',
        score: 1,
      },
      {
        title: 'endoflife.date',
        url: 'https://endoflife.date/nodejs',
        content: 'Referenced by the Claude web-search answer.',
        score: 1,
      },
    ]);
    // No page-content enrichment: the only proxyFetch usage is the wrapped
    // provider fetch, which the mocked generateText never invokes.
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  it('reports responseTime in seconds, like every sibling adapter', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(3_500);
    mockAIResponse('answer');

    const result = await searchWithClaude({ query: 'q', apiKey: 'sk-test' });

    expect(result.responseTime).toBe(2.5);
    nowSpy.mockRestore();
  });

  it('deduplicates sources by URL', async () => {
    mockAIResponse('answer', [
      urlSource('https://example.com/a', 'First', 'a'),
      urlSource('https://example.com/a', 'Duplicate', 'b'),
    ]);

    const result = await searchWithClaude({ query: 'q', apiKey: 'sk-test' });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.title).toBe('First');
  });

  it('falls back to the hostname when a source has no title', async () => {
    mockAIResponse('answer', [urlSource('https://docs.example.com/page')]);
    const result = await searchWithClaude({ query: 'q', apiKey: 'sk-test' });
    expect(result.sources[0]!.title).toBe('docs.example.com');
  });

  it('drops non-URL and non-HTTP sources', async () => {
    mockAIResponse('answer', [
      { sourceType: 'document', type: 'source', id: 'd' } as unknown as UrlSource,
      urlSource('ftp://example.com/file', 'FTP'),
      urlSource('not a url', 'Bad'),
      urlSource('https://example.com/ok', 'OK'),
    ]);

    const result = await searchWithClaude({ query: 'q', apiKey: 'sk-test' });
    expect(result.sources.map((s) => s.url)).toEqual(['https://example.com/ok']);
  });

  it('returns an empty source list when the answer cites nothing', async () => {
    mockAIResponse('answer with no citations', []);
    const result = await searchWithClaude({ query: 'q', apiKey: 'sk-test' });
    expect(result.answer).toBe('answer with no citations');
    expect(result.sources).toEqual([]);
  });

  // ── errors ─────────────────────────────────────────────────────────────────

  it('propagates model call failures', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('invalid x-api-key'));
    await expect(searchWithClaude({ query: 'q', apiKey: 'bad' })).rejects.toThrow(
      'invalid x-api-key',
    );
  });
});
