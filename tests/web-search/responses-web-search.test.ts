import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchWithResponsesWebSearch } from '@/lib/web-search/responses-web-search';

describe('Responses API web search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the Responses API web_search tool and extracts cited sources', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'web_search_call', status: 'completed' },
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'The official result is available at [Official report](https://example.test/result).',
                    annotations: [],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await searchWithResponsesWebSearch({
      query: 'latest final result',
      apiKey: 'test-key',
      baseUrl: 'https://responses-proxy.test/v1',
      model: 'search-model',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://responses-proxy.test/v1/responses',
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }),
    );
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const init = calls[0]![1];
    const body = JSON.parse(String(init.body)) as {
      model: string;
      tools: Array<{ type: string }>;
      tool_choice: string;
    };
    expect(body).toMatchObject({
      model: 'search-model',
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
    });
    expect(result.answer).toContain('official result');
    expect(result.sources).toMatchObject([
      { title: 'Official report', url: 'https://example.test/result' },
    ]);
  });

  it('preserves exact structured annotation URLs ending in a balanced parenthesis', async () => {
    const exactUrl = 'https://example.test/wiki/Function_(mathematics)';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              output: [
                { type: 'web_search_call', status: 'completed' },
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: 'See the cited reference.',
                      annotations: [{ title: 'Function', url: exactUrl }],
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    const result = await searchWithResponsesWebSearch({
      query: 'function',
      apiKey: 'test-key',
      baseUrl: 'https://responses-proxy.test/v1',
      model: 'search-model',
    });

    expect(result.sources[0]?.url).toBe(exactUrl);
  });

  it('forwards caller cancellation to the provider request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = searchWithResponsesWebSearch({
      query: 'latest result',
      apiKey: 'test-key',
      baseUrl: 'https://responses-proxy.test/v1',
      model: 'search-model',
      signal: controller.signal,
    });

    controller.abort(new DOMException('user cancelled', 'AbortError'));

    await expect(pending).rejects.toThrow('user cancelled');
  });

  it('aborts a provider request at the fixed timeout boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );

    await expect(
      searchWithResponsesWebSearch({
        query: 'latest result',
        apiKey: 'test-key',
        baseUrl: 'https://responses-proxy.test/v1',
        model: 'search-model',
        timeoutMs: 5,
      }),
    ).rejects.toThrow('timed out');
  });

  it('fails when the Responses endpoint returns no answer text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              output: [{ type: 'web_search_call', status: 'completed' }],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    await expect(
      searchWithResponsesWebSearch({
        query: 'latest result',
        apiKey: 'test-key',
        baseUrl: 'https://responses-proxy.test/v1',
        model: 'search-model',
      }),
    ).rejects.toThrow('returned no answer text');
  });

  it('fails closed when a message contains a URL but no web_search_call completed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [
                    {
                      type: 'output_text',
                      text: 'An unsupported answer with https://example.test/invented.',
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await expect(
      searchWithResponsesWebSearch({
        query: 'latest result',
        apiKey: 'test-key',
        baseUrl: 'https://responses-proxy.test/v1',
        model: 'search-model',
      }),
    ).rejects.toThrow('no completed web_search_call');
  });
});
