import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock proxy-fetch and logger so no real HTTP requests are made
vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: vi.fn(),
}));

// Mock ssrf-guard to avoid real DNS lookups in tests
vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: async (url: string): Promise<string> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Invalid URL';
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'Only HTTP(S) URLs are allowed';
    }
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
    if (privatePatterns.some((p) => p.test(hostname))) {
      return 'Local/private network URLs are not allowed';
    }
    return '';
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { proxyFetch } from '@/lib/server/proxy-fetch';

const mockProxyFetch = proxyFetch as ReturnType<typeof vi.fn>;

/** Build a minimal successful Anthropic Messages API response with no sources */
function mockApiResponse(overrides: { content?: unknown[] } = {}) {
  mockProxyFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      content: overrides.content ?? [{ type: 'text', text: 'Search result', citations: [] }],
    }),
  });
}

/** Build a page-fetch response returning simple HTML */
function mockPageResponse(html: string) {
  mockProxyFetch.mockResolvedValueOnce({
    ok: true,
    text: async () => html,
  });
}

/** Build a failing page-fetch response */
function mockPageFailure() {
  mockProxyFetch.mockResolvedValueOnce({ ok: false, status: 404 });
}

describe('searchWithClaude', () => {
  beforeEach(() => {
    vi.resetModules();
    mockProxyFetch.mockReset();
  });

  async function search(
    params: Parameters<typeof import('@/lib/web-search/claude').searchWithClaude>[0],
  ) {
    const { searchWithClaude } = await import('@/lib/web-search/claude');
    return searchWithClaude(params);
  }

  // ── baseUrl ───────────────────────────────────────────────────────────────

  it('uses the provided baseUrl to construct the messages endpoint', async () => {
    mockApiResponse();
    await search({ query: 'test', apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' });

    const [url] = mockProxyFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('uses a custom baseUrl when provided', async () => {
    mockApiResponse();
    await search({ query: 'test', apiKey: 'sk-test', baseUrl: 'https://custom.example.com' });

    const [url] = mockProxyFetch.mock.calls[0];
    expect(url).toBe('https://custom.example.com/v1/messages');
  });

  // ── tools fallback ────────────────────────────────────────────────────────

  it('uses provided tools when non-empty', async () => {
    mockApiResponse();
    const customTools = [{ type: 'web_search_custom', name: 'my_search' }];
    await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      tools: customTools,
    });

    const body = JSON.parse(mockProxyFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual(customTools);
  });

  it('uses default web_search tool when tools is undefined', async () => {
    mockApiResponse();
    await search({ query: 'test', apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' });

    const body = JSON.parse(mockProxyFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search' }]);
  });

  it('uses default web_search tool when tools is an empty array', async () => {
    mockApiResponse();
    await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
      tools: [],
    });

    const body = JSON.parse(mockProxyFetch.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search' }]);
  });

  // ── page content fetching ────────────────────────────────────────────────

  it('fetches page content for sources with no citation content', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Example' }],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });
    mockPageResponse('<html><body><p>Page content here</p></body></html>');

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].content).toBe('Page content here');
    // Second proxyFetch call should be the page fetch
    expect(mockProxyFetch.mock.calls[1][0]).toBe('https://example.com');
  });

  it('strips HTML tags and collapses whitespace from fetched page content', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Ex' }],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });
    mockPageResponse(`
      <html>
        <head><style>body { color: red }</style></head>
        <script>alert('xss')</script>
        <body>
          <h1>Title</h1>
          <p>  Some   content  </p>
        </body>
      </html>
    `);

    const result = await search({
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

  it('skips page fetch for sources that already have content from citations', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Ex' }],
        },
        {
          type: 'text',
          text: 'Answer',
          citations: [
            { url: 'https://example.com', title: 'Ex', cited_text: 'Already have this content' },
          ],
        },
      ],
    });

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    // Only 1 proxyFetch call — the API call; no page fetch
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(result.sources[0].content).toBe('Already have this content');
  });

  it('fetches multiple sources in parallel and fills content for each', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://a.com', title: 'A' },
            { type: 'web_search_result', url: 'https://b.com', title: 'B' },
          ],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });
    mockPageResponse('<p>Content A</p>');
    mockPageResponse('<p>Content B</p>');

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(result.sources).toHaveLength(2);
    // Both pages should have been fetched
    const fetchedUrls = mockProxyFetch.mock.calls.slice(1).map((call: string[]) => call[0]);
    expect(fetchedUrls).toContain('https://a.com');
    expect(fetchedUrls).toContain('https://b.com');
    expect(result.sources.find((s) => s.url === 'https://a.com')?.content).toContain('Content A');
    expect(result.sources.find((s) => s.url === 'https://b.com')?.content).toContain('Content B');
  });

  it('filters out sources for which page fetch returns no content (non-ok response)', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://dead.com', title: 'Dead' }],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });
    mockPageFailure();

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(result.sources).toHaveLength(0);
  });

  it('filters out sources for which page fetch throws (network error)', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://dead.com', title: 'Dead' }],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });
    mockProxyFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(result.sources).toHaveLength(0);
  });

  // ── SSRF protection ───────────────────────────────────────────────────────

  it('skips page fetch for localhost URLs (SSRF protection)', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'http://localhost/secret', title: 'Local' }],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    // Only the API call should have been made; no page fetch
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(result.sources).toHaveLength(0);
  });

  it('skips page fetch for private IP URLs (SSRF protection)', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'http://192.168.1.1/admin', title: 'Private' },
          ],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(result.sources).toHaveLength(0);
  });

  it('skips page fetch for non-HTTP(S) URLs (SSRF protection)', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'file:///etc/passwd', title: 'File' }],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(result.sources).toHaveLength(0);
  });

  it('skips page fetch for metadata endpoint URLs (SSRF protection)', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [
            {
              type: 'web_search_result',
              url: 'http://169.254.169.254/latest/meta-data/',
              title: 'Metadata',
            },
          ],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(result.sources).toHaveLength(0);
  });

  it('keeps sources with content and drops sources without after mixed page fetches', async () => {
    mockApiResponse({
      content: [
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://good.com', title: 'Good' },
            { type: 'web_search_result', url: 'https://dead.com', title: 'Dead' },
          ],
        },
        { type: 'text', text: 'Answer', citations: [] },
      ],
    });
    mockPageResponse('<p>Good content</p>');
    mockPageFailure();

    const result = await search({
      query: 'test',
      apiKey: 'sk-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://good.com');
  });

  // ── error propagation ─────────────────────────────────────────────────────

  it('throws when the API returns a non-ok response', async () => {
    mockProxyFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid api key',
    });

    await expect(
      search({ query: 'test', apiKey: 'bad-key', baseUrl: 'https://api.anthropic.com' }),
    ).rejects.toThrow(/Claude API error \(401\)/);
  });

  it('throws when proxyFetch rejects (network error)', async () => {
    mockProxyFetch.mockRejectedValueOnce(new Error('Network failure'));

    await expect(
      search({ query: 'test', apiKey: 'sk-test', baseUrl: 'https://api.anthropic.com' }),
    ).rejects.toThrow('Network failure');
  });
});
