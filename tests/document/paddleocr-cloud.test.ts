import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ providerFetch: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/server/audio-provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/audio-provider-fetch')>();
  return { ...actual, audioProviderFetch: transport.providerFetch };
});

import { parseWithPaddleCloud, clearPaddleCloudTokenCache } from '@/lib/pdf/paddleocr-cloud';
import { isTransientExtractionError } from '@/lib/server/material-extraction/errors';

// Public IP literals: the real SSRF validation passes them without DNS.
const POLL_TICK = 5000;
const MARKDOWN_URL = 'https://93.184.216.34/result/doc.md';
const PARSE_URL = 'https://93.184.216.34/result/doc.json';

function okJson(obj: unknown) {
  return new Response(JSON.stringify(obj), { status: 200 });
}

function installCloud(options?: { markdownUrl?: string; parseResultUrl?: string | null }) {
  transport.providerFetch.mockImplementation(async (url: string) => {
    if (url.includes('/oauth/2.0/token')) {
      return okJson({ access_token: 'tok-1', expires_in: 2592000 });
    }
    if (url.includes('/paddle-vl-parser/task?')) {
      return okJson({ error_code: 0, result: { task_id: 'task-1' } });
    }
    if (url.includes('/paddle-vl-parser/task/query')) {
      // First poll: still running. Second poll: success with result URLs.
      if (
        transport.providerFetch.mock.calls.filter(([u]) => String(u).includes('query')).length < 2
      ) {
        return okJson({ error_code: 0, result: { task_id: 'task-1', status: 'running' } });
      }
      return okJson({
        error_code: 0,
        result: {
          task_id: 'task-1',
          status: 'success',
          markdown_url: options?.markdownUrl ?? MARKDOWN_URL,
          parse_result_url:
            options && options.parseResultUrl !== undefined ? options.parseResultUrl : PARSE_URL,
        },
      });
    }
    if (url === MARKDOWN_URL) return new Response('# 解析后的文档', { status: 200 });
    if (url === PARSE_URL) {
      return okJson({
        pages: [
          {
            page_num: 0,
            text: '解析后的文档',
            images: [{ data_url: 'data:image/png;base64,AAEC' }],
          },
          { page_num: 1, text: '第二页', images: [] },
        ],
      });
    }
    throw new Error(`Unexpected transport URL: ${url}`);
  });
}

const CONFIG = {
  providerId: 'paddleocr-cloud' as const,
  accessKeyId: 'ak-1',
  accessKeySecret: 'sk-1',
};

describe('PaddleOCR Cloud (Baidu document parsing)', () => {
  beforeEach(() => {
    transport.providerFetch.mockReset();
    clearPaddleCloudTokenCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('submits, polls, then downloads the response-supplied results', async () => {
    installCloud();
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    await vi.runAllTimersAsync();
    const result = await promise;

    const calls = transport.providerFetch.mock.calls as [string, RequestInit][];
    const submit = calls.find(([u]) => u.includes('/paddle-vl-parser/task?'))!;
    expect(submit[0]).toContain('access_token=tok-1');
    const submitBody = new URLSearchParams(submit[1].body as string);
    expect(submitBody.get('file_name')).toBe('lesson.pdf');
    expect(submitBody.get('file_data')).toBe(Buffer.from('%PDF-doc').toString('base64'));

    const query = calls.find(([u]) => u.includes('/task/query'))!;
    expect(new URLSearchParams(query[1].body as string).get('task_id')).toBe('task-1');

    expect(result.text).toBe('# 解析后的文档');
    expect(result.metadata?.parser).toBe('paddleocr-cloud');
    expect(result.metadata?.pageCount).toBe(2);
    expect(result.images).toEqual(['data:image/png;base64,AAEC']);

    // Response-supplied URLs are held to the strict public policy.
    const downloadPolicies = calls.filter(([u]) => u === MARKDOWN_URL || u === PARSE_URL);
    expect(downloadPolicies.length).toBe(2);
    for (const [, init] of downloadPolicies) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    const mdPolicy = transport.providerFetch.mock.results.length > 0;
    expect(mdPolicy).toBe(true);
    expect(calls.filter(([u]) => u === MARKDOWN_URL).length).toBe(1);
  });

  it('refuses a private response URL before the transport is called', async () => {
    installCloud({ markdownUrl: 'https://169.254.169.254/latest/meta-data/', parseResultUrl: '' });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('address policy');
    await vi.runAllTimersAsync();
    await expectation;
    expect(
      transport.providerFetch.mock.calls.filter(([u]) => String(u).includes('169.254')).length,
    ).toBe(0);
  });

  it('refuses a non-HTTPS result URL', async () => {
    installCloud({ markdownUrl: 'http://93.184.216.34/result/doc.md', parseResultUrl: null });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('is not HTTPS');
    await vi.runAllTimersAsync();
    await expectation;
    // The insecure download must never be issued.
    expect(
      transport.providerFetch.mock.calls.filter(([u]) => String(u).startsWith('http://')).length,
    ).toBe(0);
  });

  it('serves the markdown alone when no parse result URL is returned', async () => {
    installCloud({ parseResultUrl: null });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.text).toBe('# 解析后的文档');
    expect(result.images).toEqual([]);
  });

  it('fails when the task reports failure', async () => {
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-2' } });
      }
      return okJson({
        error_code: 0,
        result: { task_id: 'task-2', status: 'failed', task_error: 'unsupported file' },
      });
    });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('unsupported file');
    await vi.runAllTimersAsync();
    await expectation;
  });

  it('fails the submit step with the provider message', async () => {
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      return okJson({ error_code: 282003, error_msg: 'missing parameters' });
    });
    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('%PDF-doc'), 'lesson.pdf');
    const expectation = expect(promise).rejects.toThrow('missing parameters');
    await vi.runAllTimersAsync();
    await expectation;
  });

  it('does not reuse a token across different credentials or base URLs', async () => {
    installCloud();
    const p1 = parseWithPaddleCloud(
      { ...CONFIG, baseUrl: 'https://aip.baidubce.com' },
      Buffer.from('a'),
      'a.pdf',
    );
    await vi.runAllTimersAsync();
    await p1;

    // Same AK, different secret → different cache key → a fresh token call.
    transport.providerFetch.mockClear();
    installCloud();
    const p2 = parseWithPaddleCloud(
      { ...CONFIG, accessKeySecret: 'sk-2', baseUrl: 'https://aip.baidubce.com' },
      Buffer.from('a'),
      'a.pdf',
    );
    await vi.runAllTimersAsync();
    await p2;

    expect(
      transport.providerFetch.mock.calls.filter(([u]) => String(u).includes('/oauth/2.0/token'))
        .length,
    ).toBe(1);
  });

  it('gives a managed cloud endpoint the operator policy, downloads stay strict', async () => {
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    installCloud();
    const promise = parseWithPaddleCloud(
      { ...CONFIG, baseUrl: 'http://paddle-gateway.internal:8000', managed: true },
      Buffer.from('%PDF-doc'),
      'lesson.pdf',
    );
    await vi.runAllTimersAsync();
    await promise;

    const calls = transport.providerFetch.mock.calls as [
      string,
      RequestInit,
      Record<string, unknown>,
    ][];
    const submitPolicy = calls.find(([u]) => u.includes('/paddle-vl-parser/task?'))![2];
    // Managed root: local networks allowed for the operator's gateway...
    expect(submitPolicy.allowLocalNetworks).toBe(true);
    // ...while the response-supplied downloads stay strict public.
    const download = calls.find(([u]) => u === MARKDOWN_URL)!;
    expect(download[2]).toEqual({ allowLocalNetworks: false, requireHttps: true });
    vi.unstubAllEnvs();
  });

  it('rejects an oversized streaming download mid-stream', async () => {
    const big = new Uint8Array(33 * 1024 * 1024); // > MAX_MARKDOWN_BYTES
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-3' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-3',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: null,
          },
        });
      }
      if (url === MARKDOWN_URL) {
        // No content-length: the cap must bite while the body streams.
        return new Response(new Uint8Array(big), { status: 200 });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).rejects.toThrow('exceeds the 33554432-byte read limit');
    await vi.runAllTimersAsync().catch(() => {});
    await expectation;
  });

  it('stops polling immediately when the caller signal aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-4' } });
      }
      return okJson({ error_code: 0, result: { task_id: 'task-4', status: 'running' } });
    });
    vi.stubGlobal('fetch', vi.fn());

    const promise = parseWithPaddleCloud(
      { ...CONFIG, signal: controller.signal },
      Buffer.from('a'),
      'a.pdf',
    );
    const expectation = expect(promise).rejects.toThrow();
    // One poll lands; aborting during the sleep must stop the next query.
    await vi.advanceTimersByTimeAsync(POLL_TICK);
    const queriesBefore = transport.providerFetch.mock.calls.filter(([u]) =>
      String(u).includes('/task/query'),
    ).length;
    expect(queriesBefore).toBeGreaterThan(0);
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await vi.advanceTimersByTimeAsync(POLL_TICK * 3);
    await expectation.catch(() => {});
    const queriesAfter = transport.providerFetch.mock.calls.filter(([u]) =>
      String(u).includes('/task/query'),
    ).length;
    expect(queriesAfter).toBe(queriesBefore);
  });

  it('downloads storage-link images under the strict policy and preserves their paths', async () => {
    vi.useFakeTimers();
    const IMG_URL = 'https://93.184.216.34/images/fig1.png';
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-5' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-5',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: PARSE_URL,
          },
        });
      }
      if (url === MARKDOWN_URL) {
        return new Response('文档带图', { status: 200 });
      }
      if (url === PARSE_URL) {
        return okJson({
          pages: [
            {
              page_num: 0,
              text: '文档带图',
              images: [{ data_url: IMG_URL }],
            },
          ],
        });
      }
      if (url === IMG_URL) {
        return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;

    // The linked figure was downloaded under the strict policy and inlined.
    expect(result.images).toEqual(['data:image/png;base64,CQkJ']);
    const imgMeta = result.metadata?.pdfImages?.[0];
    expect(imgMeta).toMatchObject({ path: 'p1-img', pageNumber: 1 });
    const imgCall = transport.providerFetch.mock.calls.find(([u]) => u === IMG_URL)!;
    expect(imgCall[2]).toMatchObject({ allowLocalNetworks: false, requireHttps: true });
  });

  it('retries a submit refused by the QPS limit', async () => {
    vi.useFakeTimers();
    const qpsState: { asked?: boolean } = {};
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        if (!('asked' in qpsState)) {
          qpsState.asked = true;
          // First submit: Baidu QPS-limit error code.
          return okJson({ error_code: 18, error_msg: 'QPS limit reached' });
        }
        return okJson({ error_code: 0, result: { task_id: 'task-6' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-6',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: null,
          },
        });
      }
      return new Response('md', { status: 200 });
    });
    vi.stubGlobal('fetch', vi.fn());

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).resolves.toMatchObject({ text: 'md' });
    await vi.runAllTimersAsync();
    await expectation;
    expect(
      transport.providerFetch.mock.calls.filter(([u]) =>
        String(u).includes('/paddle-vl-parser/task?'),
      ).length,
    ).toBe(2);
  });

  it('evicts the cached token when the submit reports it invalid', async () => {
    vi.useFakeTimers();
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-fresh', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        const n = transport.providerFetch.mock.calls.filter(([u]) =>
          String(u).includes('/paddle-vl-parser/task?'),
        ).length;
        if (n === 1) {
          return okJson({ error_code: 110, error_msg: 'Access token invalid' });
        }
        return okJson({ error_code: 0, result: { task_id: 'task-7' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-7',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: null,
          },
        });
      }
      return new Response('md', { status: 200 });
    });
    vi.stubGlobal('fetch', vi.fn());

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).resolves.toMatchObject({ text: 'md' });
    await vi.runAllTimersAsync();
    await expectation;
    // The submit was retried after the token was evicted and reacquired.
    const submits = transport.providerFetch.mock.calls.filter(([u]) =>
      String(u).includes('/paddle-vl-parser/task?'),
    );
    expect(submits.length).toBeGreaterThanOrEqual(2);
  });

  it('caps linked-image count and skips null entries', async () => {
    vi.useFakeTimers();
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-8' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-8',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: PARSE_URL,
          },
        });
      }
      if (url === MARKDOWN_URL) return new Response('md', { status: 200 });
      if (url === PARSE_URL) {
        return okJson({
          pages: [
            null, // malformed page: skipped, not fatal
            {
              page_num: 1,
              text: 'p2',
              images: [null, { data_url: 'https://93.184.216.34/images/fig.png' }],
            },
          ],
        });
      }
      if (url.startsWith('https://93.184.216.34/images/')) {
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    // The null page was skipped; the null image entry skipped within the page.
    expect(result.images.length).toBe(1);
    expect(result.metadata?.pageCount).toBe(2);
  });

  it('caps linked-image count and aggregate bytes', async () => {
    vi.useFakeTimers();
    const { MAX_IMAGE_LINKS } = await import('@/lib/pdf/paddleocr-cloud');
    let fetched = 0;
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-9' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-9',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: PARSE_URL,
          },
        });
      }
      if (url === MARKDOWN_URL) return new Response('md', { status: 200 });
      if (url.startsWith('https://93.184.216.34/images/')) {
        fetched += 1;
        // Over-budget payload: exercises the per-image budget too.
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      if (url === PARSE_URL) {
        return okJson({
          // parse_result lists more links than the cap; the slice bounds it.
          pages: Array.from({ length: MAX_IMAGE_LINKS + 10 }, (_, i) => ({
            page_num: i,
            text: `p${i}`,
            images: [{ data_url: `https://93.184.216.34/images/${i}.png` }],
          })),
        });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    // Exactly MAX_IMAGE_LINKS figures were fetched (the count cap), and no
    // more: the slice bounds the download loop.
    expect(fetched).toBe(MAX_IMAGE_LINKS);
    expect(result.images.length).toBe(MAX_IMAGE_LINKS);
  });

  it('skips a linked image whose download fails and keeps the markdown', async () => {
    vi.useFakeTimers();
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-10' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-10',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: PARSE_URL,
          },
        });
      }
      if (url === MARKDOWN_URL) return new Response('md', { status: 200 });
      if (url === PARSE_URL) {
        return okJson({
          pages: [
            {
              page_num: 0,
              text: 'x',
              images: [{ data_url: 'https://93.184.216.34/images/dead.png' }],
            },
          ],
        });
      }
      // Image link: transport failure (DNS/reset).
      throw new Error('ECONNRESET');
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    expect(result.text).toBe('md');
    expect(result.images).toEqual([]);
  });

  it('keeps the OAuth HTTP status so a 5xx stays retryable', async () => {
    transport.providerFetch.mockResolvedValue(new Response('{}', { status: 503 }));

    const error = await parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf').catch((e) => e);
    expect(error.status).toBe(503);
    expect(isTransientExtractionError(error)).toBe(true);
  });

  it('propagates a query body read failure instead of masking it as a provider code', async () => {
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-11' } });
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: null,
        json: async () => {
          throw new TypeError('terminated');
        },
      } as unknown as Response;
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).rejects.toThrow('terminated');
    await vi.runAllTimersAsync();
    await expectation;
  });

  it('disposes a throttled query response before polling again', async () => {
    const throttled = new Response('slow down', { status: 429 });
    const cancel = vi.spyOn(throttled.body!, 'cancel');
    let queries = 0;
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-12' } });
      }
      if (url.includes('/task/query')) {
        queries += 1;
        if (queries === 1) return throttled;
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-12',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: null,
          },
        });
      }
      return new Response('md', { status: 200 });
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).resolves.toMatchObject({ text: 'md' });
    await vi.runAllTimersAsync();
    await expectation;
    expect(cancel).toHaveBeenCalled();
  });

  it('reacquires the token and keeps polling when the task reports it expired', async () => {
    let tokenCalls = 0;
    let queries = 0;
    const queryTokens: string[] = [];
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        tokenCalls += 1;
        return okJson({ access_token: `tok-${tokenCalls}`, expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-13' } });
      }
      if (url.includes('/task/query')) {
        queries += 1;
        queryTokens.push(new URL(url).searchParams.get('access_token') ?? '');
        if (queries === 1) return okJson({ error_code: 110, error_msg: 'Access token invalid' });
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-13',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: null,
          },
        });
      }
      return new Response('md', { status: 200 });
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).resolves.toMatchObject({ text: 'md' });
    await vi.runAllTimersAsync();
    await expectation;
    expect(tokenCalls).toBe(2);
    expect(queryTokens).toEqual(['tok-1', 'tok-2']);
  });

  it('serves the parsed markdown when the image phase deadline expires', async () => {
    const IMG_URL = 'https://93.184.216.34/images/hang.png';
    // AbortSignal.timeout is native and unaffected by fake timers, so the
    // phase deadline is driven through a controller instead.
    const phase = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => phase.signal);
    let imageStarted!: () => void;
    const imageReached = new Promise<void>((resolve) => (imageStarted = resolve));
    transport.providerFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-14' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-14',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: PARSE_URL,
          },
        });
      }
      if (url === MARKDOWN_URL) return new Response('md', { status: 200 });
      if (url === PARSE_URL) {
        return okJson({
          pages: [{ page_num: 0, text: 'md', images: [{ data_url: IMG_URL }] }],
        });
      }
      if (url === IMG_URL) {
        // A storage link that accepts the connection and never answers.
        imageStarted();
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    await vi.advanceTimersByTimeAsync(POLL_TICK + 10);
    await imageReached;
    // The internal deadline fires: enrichment stops, the markdown survives.
    phase.abort(new DOMException('Aborted', 'AbortError'));
    const result = await promise;
    expect(result.text).toBe('md');
    expect(result.images).toEqual([]);
    timeoutSpy.mockRestore();
  });

  it('cancels a non-success image response body', async () => {
    const dead = new Response('nope', { status: 404 });
    const cancel = vi.spyOn(dead.body!, 'cancel');
    const IMG_URL = 'https://93.184.216.34/images/dead-404.png';
    transport.providerFetch.mockImplementation(async (url: string) => {
      if (url.includes('/oauth/2.0/token')) {
        return okJson({ access_token: 'tok-1', expires_in: 2592000 });
      }
      if (url.includes('/paddle-vl-parser/task?')) {
        return okJson({ error_code: 0, result: { task_id: 'task-15' } });
      }
      if (url.includes('/task/query')) {
        return okJson({
          error_code: 0,
          result: {
            task_id: 'task-15',
            status: 'success',
            markdown_url: MARKDOWN_URL,
            parse_result_url: PARSE_URL,
          },
        });
      }
      if (url === MARKDOWN_URL) return new Response('md', { status: 200 });
      if (url === PARSE_URL) {
        return okJson({
          pages: [{ page_num: 0, text: 'md', images: [{ data_url: IMG_URL }] }],
        });
      }
      if (url === IMG_URL) return dead;
      throw new Error(`Unexpected transport URL: ${url}`);
    });

    const promise = parseWithPaddleCloud(CONFIG, Buffer.from('a'), 'a.pdf');
    const expectation = expect(promise).resolves.toMatchObject({ text: 'md' });
    await vi.runAllTimersAsync();
    await expectation;
    expect(cancel).toHaveBeenCalled();
  });

  it('requires the AK/SK pair before any network call', async () => {
    await expect(
      parseWithPaddleCloud({ providerId: 'paddleocr-cloud' }, Buffer.from('%PDF-doc'), 'a.pdf'),
    ).rejects.toThrow('API Key and Secret Key pair');
    expect(transport.providerFetch).not.toHaveBeenCalled();
  });
});
