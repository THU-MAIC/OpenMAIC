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

vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mockCreateAnthropic }));

// ── Infrastructure mocks ──────────────────────────────────────────────────────

vi.mock('@/lib/server/proxy-fetch', () => ({ proxyFetch: vi.fn() }));

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: async (url: string): Promise<string> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Invalid URL';
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'Only HTTP(S) URLs are allowed';
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const privatePatterns = [
      /^localhost$/i,
      /^127\./,
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^169\.254\./,
      /^::1$/,
    ];
    if (privatePatterns.some((p) => p.test(hostname)))
      return 'Local/private network URLs are not allowed';
    return '';
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { searchWithClaude } from '@/lib/web-search/claude';

const mockProxyFetch = proxyFetch as ReturnType<typeof vi.fn>;

type UrlSource = { sourceType: 'url'; type: 'source'; id: string; url: string; title?: string };

function mockAIResponse(text = 'Search result', sources: UrlSource[] = []) {
  mockGenerateText.mockResolvedValueOnce({ text, sources });
}

function mockPageResponse(html: string) {
  mockProxyFetch.mockResolvedValueOnce({ ok: true, text: async () => html });
}

function mockPageFailure() {
  mockProxyFetch.mockResolvedValueOnce({ ok: false, status: 404 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('searchWithClaude', () => {
  beforeEach(() => {
    mockProxyFetch.mockReset();
    mockGenerateText.mockReset();
    mockCreateAnthropic.mockClear();
  });

  // ── fetch interceptor: allowed_callers injection ──────────────────────────

  it('injects allowed_callers=["direct"] on tools that omit it', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' });

    const wrappedFetch = mockCreateAnthropic.mock.calls[0][0].fetch as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;

    const body = JSON.stringify({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] });
    mockProxyFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await wrappedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });

    const sentBody = JSON.parse(mockProxyFetch.mock.calls[0][1].body as string);
    expect(sentBody.tools[0].allowed_callers).toEqual(['direct']);
  });

  it('does not overwrite allowed_callers when already set', async () => {
    mockAIResponse();
    await searchWithClaude({ query: 'test', apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' });

    const wrappedFetch = mockCreateAnthropic.mock.calls[0][0].fetch as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;

    const body = JSON.stringify({
      tools: [{ type: 'web_search_20260209', name: 'web_search', allowed_callers: ['agent'] }],
    });
    mockProxyFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await wrappedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body });

    const sentBody = JSON.parse(mockProxyFetch.mock.calls[0][1].body as string);
    expect(sentBody.tools[0].allowed_callers).toEqual(['agent']);
  });

  // ── provider setup ────────────────────────────────────────────────────────

  it('passes baseUrl and apiKey to createAnthropic', async () => {
    mockAIResponse();
    await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(mockCreateAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-test' }),
    );
  });

  it('calls generateText with the web_search tool', async () => {
    mockAIResponse();
    await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ tools: expect.objectContaining({ web_search: mockTool }) }),
    );
  });

  it('falls back to claude-sonnet-4-6 when no modelId provided', async () => {
    mockAIResponse();
    await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(mockProvider).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('uses the provided modelId', async () => {
    mockAIResponse();
    await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      modelId: 'claude-opus-4-7',
    });
    expect(mockProvider).toHaveBeenCalledWith('claude-opus-4-7');
  });

  // ── answer ────────────────────────────────────────────────────────────────

  it('returns the answer text from generateText', async () => {
    mockAIResponse('Comprehensive answer about the topic');
    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(result.answer).toBe('Comprehensive answer about the topic');
    expect(result.query).toBe('test');
  });

  // ── page content fetching ─────────────────────────────────────────────────

  it('fetches page content for each source URL', async () => {
    mockAIResponse('Answer', [
      { sourceType: 'url', type: 'source', id: '1', url: 'https://example.com', title: 'Example' },
    ]);
    mockPageResponse('<html><body><p>Page content here</p></body></html>');

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(mockProxyFetch).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].content).toBe('Page content here');
  });

  it('strips HTML tags and collapses whitespace from fetched page content', async () => {
    mockAIResponse('Answer', [
      { sourceType: 'url', type: 'source', id: '1', url: 'https://example.com', title: 'Ex' },
    ]);
    mockPageResponse(`
      <html>
        <head><style>body { color: red }</style></head>
        <script>alert('xss')</script>
        <body><h1>Title</h1><p>  Some   content  </p></body>
      </html>
    `);

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(result.sources[0].content).not.toContain('<');
    expect(result.sources[0].content).not.toContain('alert');
    expect(result.sources[0].content).not.toContain('color: red');
    expect(result.sources[0].content).toContain('Title');
    expect(result.sources[0].content).toContain('Some content');
  });

  it('fetches multiple sources in parallel', async () => {
    mockAIResponse('Answer', [
      { sourceType: 'url', type: 'source', id: '1', url: 'https://a.com', title: 'A' },
      { sourceType: 'url', type: 'source', id: '2', url: 'https://b.com', title: 'B' },
    ]);
    mockPageResponse('<p>Content A</p>');
    mockPageResponse('<p>Content B</p>');

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(result.sources).toHaveLength(2);
    const fetchedUrls = mockProxyFetch.mock.calls.map((call: unknown[]) => call[0]);
    expect(fetchedUrls).toContain('https://a.com');
    expect(fetchedUrls).toContain('https://b.com');
    expect(result.sources.find((s) => s.url === 'https://a.com')?.content).toContain('Content A');
    expect(result.sources.find((s) => s.url === 'https://b.com')?.content).toContain('Content B');
  });

  it('filters out sources where page fetch returns non-ok response', async () => {
    mockAIResponse('Answer', [
      { sourceType: 'url', type: 'source', id: '1', url: 'https://dead.com', title: 'Dead' },
    ]);
    mockPageFailure();

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(result.sources).toHaveLength(0);
  });

  it('filters out sources where page fetch throws (network error)', async () => {
    mockAIResponse('Answer', [
      { sourceType: 'url', type: 'source', id: '1', url: 'https://dead.com', title: 'Dead' },
    ]);
    mockProxyFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(result.sources).toHaveLength(0);
  });

  it('keeps sources with content and drops sources without after mixed page fetches', async () => {
    mockAIResponse('Answer', [
      { sourceType: 'url', type: 'source', id: '1', url: 'https://good.com', title: 'Good' },
      { sourceType: 'url', type: 'source', id: '2', url: 'https://dead.com', title: 'Dead' },
    ]);
    mockPageResponse('<p>Good content</p>');
    mockPageFailure();

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://good.com');
  });

  it('ignores non-url sources (document sources)', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: 'Answer',
      sources: [
        { sourceType: 'document', type: 'source', id: '1', mediaType: 'text/plain', title: 'Doc' },
        { sourceType: 'url', type: 'source', id: '2', url: 'https://example.com', title: 'Web' },
      ],
    });
    mockPageResponse('<p>Web content</p>');

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://example.com');
  });

  // ── SSRF protection ───────────────────────────────────────────────────────

  it('skips page fetch for localhost URLs (SSRF protection)', async () => {
    mockAIResponse('Answer', [
      {
        sourceType: 'url',
        type: 'source',
        id: '1',
        url: 'http://localhost/secret',
        title: 'Local',
      },
    ]);

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
  });

  it('skips page fetch for private IP URLs (SSRF protection)', async () => {
    mockAIResponse('Answer', [
      {
        sourceType: 'url',
        type: 'source',
        id: '1',
        url: 'http://192.168.1.1/admin',
        title: 'Private',
      },
    ]);

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
  });

  it('skips page fetch for non-HTTP(S) URLs (SSRF protection)', async () => {
    mockAIResponse('Answer', [
      { sourceType: 'url', type: 'source', id: '1', url: 'file:///etc/passwd', title: 'File' },
    ]);

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
  });

  it('skips page fetch for cloud metadata endpoint URLs (SSRF protection)', async () => {
    mockAIResponse('Answer', [
      {
        sourceType: 'url',
        type: 'source',
        id: '1',
        url: 'http://169.254.169.254/latest/meta-data/',
        title: 'Meta',
      },
    ]);

    const result = await searchWithClaude({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(mockProxyFetch).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(0);
  });

  // ── error propagation ─────────────────────────────────────────────────────

  it('throws when generateText rejects', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Claude API error (401): invalid x-api-key'));

    await expect(
      searchWithClaude({ query: 'test', apiKey: 'bad-key', baseUrl: 'https://api.anthropic.com' }),
    ).rejects.toThrow('Claude API error (401)');
  });

  it('throws when generateText rejects with a network error', async () => {
    mockGenerateText.mockRejectedValueOnce(new Error('Network failure'));

    await expect(
      searchWithClaude({ query: 'test', apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' }),
    ).rejects.toThrow();
  });
});
