import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createClassroomWebFetchContext,
  buildNativeWebFetchTool,
} from '@/lib/chat/pi/tools/web-fetch';
import { buildNativeWebSearchTool } from '@/lib/chat/pi/tools/web-search';
import type { StatelessChatRequest } from '@/lib/types/chat';
import type { ExtractedWebPage, FetchUrlOptions } from '@/lib/web-fetch/builtin-extraction';

const services = vi.hoisted(() => ({
  resolveExtractionServices: vi.fn(async () => ({ document: null })),
}));
vi.mock('@/lib/server/material-extraction/services', () => services);

const url = 'https://example.com/article';
const connection = {
  providerId: 'builtin',
  managed: true,
  userEndpoint: false,
  origin: 'default' as const,
};
function page(overrides: Partial<ExtractedWebPage> = {}): ExtractedWebPage {
  return {
    sourceUrl: url,
    finalUrl: url,
    title: 'Article',
    markdown: 'Useful evidence. '.repeat(600),
    fetchedAt: '2026-10-16T12:00:00Z',
    contentType: 'text/html',
    truncated: false,
    downloadedBytes: 10_000,
    ...overrides,
  };
}
function messages(text: string, role = 'user'): StatelessChatRequest['messages'] {
  return [{ id: 'm1', role, parts: [{ type: 'text', text }] }] as StatelessChatRequest['messages'];
}
function harness(overrides: Partial<Parameters<typeof createClassroomWebFetchContext>[0]> = {}) {
  const fetchUrl = vi.fn(async (_url: string, _options?: FetchUrlOptions) => page());
  const context = createClassroomWebFetchContext({
    connection,
    workspaceId: null,
    messages: messages(`Read ${url}`),
    fetchUrl,
    ...overrides,
  });
  return { fetchUrl, context, tool: buildNativeWebFetchTool(context) };
}
function read(h: ReturnType<typeof harness>, input = url, offset?: number, signal?: AbortSignal) {
  return h.tool.execute('f1', { url: input, ...(offset === undefined ? {} : { offset }) }, signal);
}

describe('classroom Native fetch_url', () => {
  // The reader stack loads lazily on the first read; warm it outside the per-test timeout.
  beforeAll(async () => {
    await import('@/lib/server/agent-runtime/fetch-url');
  }, 30_000);

  it('reads a pasted link with bounded untrusted evidence and forwards the slot connection', async () => {
    const h = harness({
      connection: {
        ...connection,
        providerId: 'kimi',
        apiKey: 'secret',
        baseUrl: 'https://api.moonshot.cn/v1',
        proxy: 'http://proxy.example:8080',
        options: { custom: true },
      },
    });
    const result = await read(h);
    expect(result.details).toMatchObject({
      trusted: { status: 'done', nextOffset: 8000 },
      untrusted: { url, title: 'Article', content: page().markdown.slice(0, 8000) },
    });
    expect(h.fetchUrl).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        providerId: 'kimi',
        credentials: {
          apiKey: 'secret',
          baseUrl: 'https://api.moonshot.cn/v1',
          proxy: 'http://proxy.example:8080',
          options: { custom: true },
        },
        isUrlAllowed: expect.any(Function),
        maxBytes: 1024 * 1024,
      }),
    );
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects model-authored links and deceptive origin prefixes before dispatch', async () => {
    const h = harness({ messages: [...messages(url, 'assistant'), ...messages('Explain this.')] });
    expect((await read(h)).details).toMatchObject({ trusted: { status: 'url_not_observed' } });
    expect(h.fetchUrl).not.toHaveBeenCalled();
    const observed = harness();
    expect((await read(observed, 'https://example.com.evil.test/article')).details).toMatchObject({
      trusted: { status: 'url_not_observed' },
    });
    expect(observed.fetchUrl).not.toHaveBeenCalled();
  });

  it('search authorizes returned source origins before same-Child fetching', async () => {
    const h = harness({ messages: messages('Find evidence.') });
    const search = buildNativeWebSearchTool({
      config: { providerId: 'tavily', apiKey: 'key' },
      onUrlsObserved: h.context.observeUrls,
      search: vi.fn(async () => ({
        query: 'evidence',
        answer: 'Only a short summary.',
        responseTime: 0.1,
        sources: [{ url, title: 'Article', content: 'Snippet', score: 1 }],
      })),
    });
    await search.execute('s1', { query: 'evidence' });
    expect((await read(h)).details).toMatchObject({ trusted: { status: 'done' } });
    expect(h.fetchUrl).toHaveBeenCalledTimes(1);
  });

  it('does not authorize a URL embedded only in a search answer', async () => {
    const h = harness({ messages: messages('Find evidence.') });
    const search = buildNativeWebSearchTool({
      config: { providerId: 'tavily', apiKey: 'key' },
      onUrlsObserved: h.context.observeUrls,
      search: vi.fn(async () => ({
        query: 'evidence',
        answer: url,
        responseTime: 0.1,
        sources: [
          { url: 'https://other.example/article', title: 'Article', content: url, score: 1 },
        ],
      })),
    });
    await search.execute('s1', { query: 'evidence' });
    expect((await read(h)).details).toMatchObject({ trusted: { status: 'url_not_observed' } });
    expect(h.fetchUrl).not.toHaveBeenCalled();
  });

  it('matches the existing origin contract and gates redirect targets', async () => {
    const h = harness();
    await read(h, 'https://example.com/another-page');
    const options = h.fetchUrl.mock.calls[0]?.[1] as unknown as {
      isUrlAllowed: (input: string) => Promise<boolean>;
    };
    expect(await options.isUrlAllowed('https://example.com/redirected')).toBe(true);
    expect(await options.isUrlAllowed('https://other.example/redirected')).toBe(false);
  });

  it.each([
    'http://127.0.0.1/a',
    'http://2130706433/a',
    'http://169.254.169.254/a',
    'https://user:pass@example.com/a',
    'file:///tmp/a',
  ])('blocks unsafe target %s before dispatch even if shared', async (input) => {
    const h = harness({ messages: messages(input) });
    expect((await read(h, input)).details).toMatchObject({ trusted: { status: 'blocked' } });
    expect(h.fetchUrl).not.toHaveBeenCalled();
  });

  it('refuses a disallowed reported final URL and never authorizes links inside fetched text', async () => {
    const h = harness({
      fetchUrl: vi.fn(async () => page({ finalUrl: 'https://unseen.example/final' })),
    });
    expect((await read(h)).details).toMatchObject({ trusted: { status: 'blocked' } });
    const textLink = harness({
      fetchUrl: vi.fn(async () => page({ markdown: 'Read https://unseen.example/final next.' })),
    });
    await read(textLink);
    expect((await read(textLink, 'https://unseen.example/final')).details).toMatchObject({
      trusted: { status: 'url_not_observed' },
    });
  });

  it('shares the request budget across tool instances and reuses pages without another fetch', async () => {
    const h = harness();
    await read(h);
    const secondChild = buildNativeWebFetchTool(h.context);
    await secondChild.execute('f2', { url, offset: 8000 });
    expect(h.fetchUrl).toHaveBeenCalledTimes(1);
    await secondChild.execute('f3', { url: 'https://example.com/second' });
    expect((await read(h, 'https://example.com/third')).details).toMatchObject({
      trusted: { status: 'budget_exhausted' },
    });
    expect(h.fetchUrl).toHaveBeenCalledTimes(2);
    expect((await read(h)).details).toMatchObject({ trusted: { status: 'done' } });
  });

  it('failed attempts consume budget and exceptions do not expose provider details', async () => {
    const fetchUrl = vi.fn(async () => {
      throw new Error('secret-key at private-provider-endpoint');
    });
    const h = harness({ fetchUrl });
    const result = await read(h);
    expect(JSON.stringify(result)).not.toContain('secret-key');
    expect(result).toMatchObject({ isError: true, details: { trusted: { status: 'error' } } });
    await read(h, 'https://example.com/second');
    expect((await read(h, 'https://example.com/third')).details).toMatchObject({
      trusted: { status: 'budget_exhausted' },
    });
    expect(fetchUrl).toHaveBeenCalledTimes(2);
  });

  it('returns a failed URL as final without spending budget again', async () => {
    const fetchUrl = vi.fn(async () => {
      throw new Error('upstream refused');
    });
    const h = harness({ fetchUrl });
    await read(h);
    const retry = await buildNativeWebFetchTool(h.context).execute('f2', { url });

    expect(retry).toMatchObject({ isError: true, details: { trusted: { status: 'error' } } });
    expect(JSON.stringify(retry.details)).toContain('was not retried');
    expect(fetchUrl).toHaveBeenCalledTimes(1);
    await read(h, 'https://example.com/second');
    expect(fetchUrl).toHaveBeenCalledTimes(2);
  });

  it('treats a #fragment as the same page for paging, budget and failures', async () => {
    const h = harness();
    await read(h, `${url}#intro`);
    expect((await read(h, `${url}#notes`, 8000)).details).toMatchObject({
      trusted: { status: 'done', offset: 8000 },
    });
    expect(h.fetchUrl).toHaveBeenCalledOnce();
    expect(h.fetchUrl.mock.calls[0]?.[0]).toBe(url);
    expect((await read(h, 'https://example.com/second')).details).toMatchObject({
      trusted: { status: 'done' },
    });

    const refused = vi.fn(async () => {
      throw new Error('upstream refused');
    });
    const failing = harness({ fetchUrl: refused });
    await read(failing, `${url}#a`);
    expect(JSON.stringify((await read(failing, `${url}#b`)).details)).toContain('was not retried');
    expect(refused).toHaveBeenCalledOnce();
  });

  it("resolves a PDF's document service for the request's own workspace, without following a claim", async () => {
    const h = harness({ workspaceId: 'workspace-a' });
    await read(h);
    const options = h.fetchUrl.mock.calls[0]?.[1] as FetchUrlOptions;
    expect(options.extractionServices).toBeUndefined();
    expect(services.resolveExtractionServices).not.toHaveBeenCalled();
    await options.loadExtractionServices?.();
    expect(services.resolveExtractionServices).toHaveBeenCalledWith('workspace-a', {
      forward: false,
    });
  });

  it('pages content without persisting it and preserves extraction truncation', async () => {
    const h = harness({ fetchUrl: vi.fn(async () => page({ truncated: true })) });
    expect((await read(h, url, 8000)).details).toMatchObject({
      trusted: { status: 'done', offset: 8000, truncated: true },
    });
    expect((await read(h, url, 100_000)).details).toMatchObject({
      trusted: { status: 'end_of_content' },
    });
  });

  it('has no observations, cached pages or budget shared with another request', async () => {
    const first = harness();
    await read(first);
    const next = harness({ messages: messages('Continue.') });
    expect((await read(next)).details).toMatchObject({ trusted: { status: 'url_not_observed' } });
    expect(next.fetchUrl).not.toHaveBeenCalled();
  });

  it('settles a signal-ignoring fetch on deadline and aborts the producer', async () => {
    let signal: AbortSignal | undefined;
    const h = harness({
      timeoutMs: 10,
      fetchUrl: vi.fn(async (_url, options) => {
        signal = options?.signal;
        return new Promise<ExtractedWebPage>(() => {});
      }),
    });
    expect(await read(h)).toMatchObject({
      isError: true,
      details: { trusted: { status: 'timeout' } },
    });
    expect(signal?.aborted).toBe(true);
  });

  it('propagates caller cancellation and ignores late completion', async () => {
    let release!: (page: ExtractedWebPage) => void;
    const fetchUrl = vi.fn(
      () =>
        new Promise<ExtractedWebPage>((resolve) => {
          release = resolve;
        }),
    );
    const h = harness({ fetchUrl });
    const controller = new AbortController();
    const pending = read(h, url, undefined, controller.signal);
    await vi.waitFor(() => expect(fetchUrl).toHaveBeenCalledOnce());
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    release(page());
    fetchUrl.mockResolvedValue(page());
    await read(h);
    expect(fetchUrl).toHaveBeenCalledTimes(2);
  });

  it('does no work for an already-cancelled call', async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(read(h, url, undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(h.fetchUrl).not.toHaveBeenCalled();
  });

  it('rejects coerced, extra and inherited arguments before the handler', () => {
    const { tool } = harness();
    for (const args of [
      { url, offset: '1' },
      { url, extra: true },
      { url, offset: -1 },
      Object.create({ url }),
    ]) {
      expect(() => tool.prepareArguments?.(args)).toThrow('strict schema');
    }
    expect(tool.prepareArguments?.({ url, offset: 0 })).toEqual({ url, offset: 0 });
  });
});
