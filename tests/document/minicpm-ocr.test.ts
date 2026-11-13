/**
 * MiniCPM-OCR document parsing, driven through a controllable transport.
 *
 * The client is a job/poll flow against the vendor's document-parse API. These
 * tests pin:
 *
 *  - the submit request shape (multipart file + model, bearer key);
 *  - polling until Success and assembling Markdown from pages when the
 *    top-level `markdown` is absent (the self-hosted web demo);
 *  - the layout blocks mapped from the per-page result;
 *  - that upstream failure text never reaches the caller;
 *  - the hosted API's key requirement versus a keyless self-hosted endpoint;
 *  - cancellation and the response-body cap.
 *
 * The real transport's address policy and pinning are covered by the PDF
 * provider transport tests; here `providerFetch` is stubbed so the protocol
 * itself is what is under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ providerFetch: vi.fn() }));
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => logger,
}));

// Keep every other export of the audio transport real and only replace the
// request function, which `providerFetch` re-exports.
vi.mock('@/lib/server/audio-provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/audio-provider-fetch')>();
  return { ...actual, audioProviderFetch: transport.providerFetch };
});

import { getDocumentExtractorProvider } from '@/lib/document';
import {
  parseWithMiniCPMOCR,
  retryAfterMs,
  verifyMiniCPMOCRConnection,
} from '@/lib/pdf/minicpm-ocr';
import { parsePDF } from '@/lib/pdf/pdf-providers';
import { MINICPM_OCR_DEFAULT_BASE } from '@/lib/pdf/constants';

interface Call {
  url: string;
  init: RequestInit | undefined;
  policy: { allowLocalNetworks?: boolean; rejectRedirects?: boolean } | undefined;
}

function calls(): Call[] {
  const raw = transport.providerFetch.mock.calls as unknown as Array<
    [string | URL, RequestInit | undefined, Call['policy']]
  >;
  return raw.map(([input, init, policy]) => ({ url: String(input), init, policy }));
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function install(responses: {
  submit?: () => Response;
  polls: Array<() => Response>;
  onPoll?: (index: number) => void;
}) {
  let poll = 0;
  transport.providerFetch.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/document-parse/jobs')) {
      return (
        responses.submit?.() ??
        json({ id: 'job-1', status: 'Running', pages_done: 0, pages_total: 0 }, { status: 202 })
      );
    }
    if (url.includes('/document-parse/jobs/job-1')) {
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      const index = Math.min(poll, responses.polls.length - 1);
      const response = responses.polls[index]!;
      poll += 1;
      responses.onPoll?.(index);
      return response();
    }
    throw new Error(`Unexpected transport URL: ${url}`);
  });
}

const PDF = Buffer.from('%PDF-1.7\n');

const SUCCESS_JOB = {
  id: 'job-1',
  status: 'Success',
  pages_done: 2,
  pages_total: 2,
  markdown: '# Parsed lesson\n\n| A | B |\n| - | - |\n| 1 | 2 |',
  pages: [
    {
      metadata: { page_index: 0 },
      choices: [{ message: { content: '# Parsed lesson' } }],
      ocr: {
        blocks: [
          {
            label: 'doc_title',
            content: 'Parsed lesson',
            bbox: [10, 20, 110, 60],
          },
        ],
      },
    },
    {
      metadata: { page_index: 1 },
      choices: [{ message: { content: 'Table page' } }],
      ocr: {
        blocks: [
          {
            label: 'table',
            content: '| A | B |',
            bbox: [5, 5, 55, 25],
          },
        ],
      },
    },
  ],
};

describe('parseWithMiniCPMOCR', () => {
  beforeEach(() => {
    transport.providerFetch.mockReset();
    for (const mock of Object.values(logger)) mock.mockClear();
  });

  it('accepts a job finished with another terminal status spelling', async () => {
    install({ polls: [() => json({ ...SUCCESS_JOB, status: 'Completed' })] });

    const parsed = await parseWithMiniCPMOCR(
      { providerId: 'minicpm-ocr', apiKey: 'test-key' },
      PDF,
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );

    expect(parsed.text).toBe(SUCCESS_JOB.markdown);
  });

  it('submits the document, polls the job, and returns its Markdown and layout', async () => {
    install({
      polls: [
        () => json({ id: 'job-1', status: 'Running', pages_done: 1, pages_total: 2 }),
        () => json(SUCCESS_JOB),
      ],
    });

    const parsed = await parseWithMiniCPMOCR(
      { providerId: 'minicpm-ocr', apiKey: 'test-key', managed: true },
      PDF,
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );

    expect(parsed.text).toBe(SUCCESS_JOB.markdown);
    expect(parsed.images).toEqual([]);
    expect(parsed.metadata).toMatchObject({
      fileName: 'lesson.pdf',
      pageCount: 2,
      parser: 'minicpm-ocr',
      taskId: 'job-1',
    });
    expect(parsed.layout).toEqual([
      {
        page: 1,
        type: 'title',
        content: 'Parsed lesson',
        position: { x: 10, y: 20, width: 100, height: 40 },
      },
      {
        page: 2,
        type: 'table',
        content: '| A | B |',
        position: { x: 5, y: 5, width: 50, height: 20 },
      },
    ]);

    const [submit, firstPoll] = calls();
    expect(submit!.url).toBe(`${MINICPM_OCR_DEFAULT_BASE}/document-parse/jobs`);
    expect(submit!.init?.method).toBe('POST');
    expect((submit!.init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    // A server-managed endpoint may reach a local network; redirects stay refused.
    expect(submit!.policy).toMatchObject({ allowLocalNetworks: true, rejectRedirects: true });

    const form = submit!.init?.body as FormData;
    expect(form.get('model')).toBe('MiniCPM-OCR-1.0');
    const file = form.get('file') as File;
    expect(file.name).toBe('lesson.pdf');

    expect(firstPoll!.url).toBe(`${MINICPM_OCR_DEFAULT_BASE}/document-parse/jobs/job-1`);
  });

  it('stops the server-side job when polling sees an unknown status', async () => {
    install({ polls: [() => json({ id: 'job-1', status: 'Mystery' })] });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'test-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('MiniCPM-OCR returned an unexpected job status');

    const cancel = calls().find((call) => call.init?.method === 'DELETE');
    expect(cancel?.url).toBe(`${MINICPM_OCR_DEFAULT_BASE}/document-parse/jobs/job-1`);
  });

  it('rejects a non-object poll payload and stops the server-side job', async () => {
    install({
      polls: [
        () =>
          new Response('null', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ],
    });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'test-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('invalid JSON response');

    const cancel = calls().find((call) => call.init?.method === 'DELETE');
    expect(cancel?.url).toBe(`${MINICPM_OCR_DEFAULT_BASE}/document-parse/jobs/job-1`);
  });

  it('stops the server-side job when the caller aborts during polling', async () => {
    const controller = new AbortController();
    install({
      polls: [() => json({ id: 'job-1', status: 'Running', pages_done: 0, pages_total: 2 })],
      onPoll: () => controller.abort(),
    });

    await expect(
      parseWithMiniCPMOCR(
        { providerId: 'minicpm-ocr', apiKey: 'test-key', signal: controller.signal },
        PDF,
        { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
      ),
    ).rejects.toThrow();

    const cancel = calls().find((call) => call.init?.method === 'DELETE');
    expect(cancel?.url).toBe(`${MINICPM_OCR_DEFAULT_BASE}/document-parse/jobs/job-1`);
  });

  it('filters page furniture, keeps block order, and reports failed blocks', async () => {
    install({
      polls: [
        () =>
          json({
            id: 'job-1',
            status: 'Success',
            pages_done: 1,
            pages_total: 1,
            pages: [
              {
                metadata: { page_index: 0 },
                choices: [{ message: { content: 'Second\n\nThird' } }],
                ocr: {
                  blocks: [
                    {
                      order: 2,
                      label: 'text',
                      content: 'Second',
                      bbox: [10, 20, 110, 60],
                      status: 'ok',
                    },
                    { order: 0, label: 'header', content: 'Running header', status: 'ok' },
                    {
                      order: 1,
                      label: 'table',
                      content: '',
                      bbox: [5, 5, 55, 25],
                      status: 'failed',
                    },
                    {
                      order: 3,
                      label: 'text',
                      content: 'Third',
                      bbox: [10, 70, 110, 90],
                      status: 'ok',
                    },
                  ],
                },
              },
            ],
          }),
      ],
    });

    const parsed = await parseWithMiniCPMOCR(
      { providerId: 'minicpm-ocr', apiKey: 'test-key' },
      PDF,
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );

    expect(parsed.layout).toEqual([
      {
        page: 1,
        type: 'text',
        content: 'Second',
        position: { x: 10, y: 20, width: 100, height: 40 },
      },
      {
        page: 1,
        type: 'text',
        content: 'Third',
        position: { x: 10, y: 70, width: 100, height: 20 },
      },
    ]);
    expect(parsed.diagnostics).toEqual([
      { severity: 'warning', message: '1 block(s) were not recognized: page 1 block 1' },
    ]);
    expect(
      logger.warn.mock.calls.some(([message]) =>
        String(message).includes('block(s) were not recognized'),
      ),
    ).toBe(true);
  });

  it('omits coordinates on a page turned for recognition', async () => {
    install({
      polls: [
        () =>
          json({
            id: 'job-1',
            status: 'Success',
            pages_done: 1,
            pages_total: 1,
            pages: [
              {
                metadata: { page_index: 0 },
                choices: [{ message: { content: 'Turned page' } }],
                ocr: {
                  rotation: { applied: true, orientation_angle: 180 },
                  blocks: [
                    {
                      label: 'text',
                      content: 'Turned page',
                      bbox: [1, 2, 11, 22],
                      status: 'ok',
                    },
                  ],
                },
              },
            ],
          }),
      ],
    });

    const parsed = await parseWithMiniCPMOCR(
      { providerId: 'minicpm-ocr', apiKey: 'test-key' },
      PDF,
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );

    expect(parsed.layout).toEqual([{ page: 1, type: 'text', content: 'Turned page' }]);
    expect(parsed.diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'page 1 was turned 180 degrees for recognition; its coordinates are omitted',
      },
    ]);
    expect(
      logger.warn.mock.calls.some(([message]) =>
        String(message).includes('was turned 180 degrees'),
      ),
    ).toBe(true);
  });

  it('reports a page whose result status is not complete', async () => {
    install({
      polls: [
        () =>
          json({
            id: 'job-1',
            status: 'Success',
            pages_done: 2,
            pages_total: 2,
            pages: [
              {
                metadata: { page_index: 0 },
                result_status: 'Failed',
                choices: [],
                ocr: { blocks: [] },
              },
              {
                metadata: { page_index: 1 },
                result_status: 'complete',
                choices: [{ message: { content: 'Second page' } }],
              },
            ],
          }),
      ],
    });

    const parsed = await parseWithMiniCPMOCR(
      { providerId: 'minicpm-ocr', apiKey: 'test-key' },
      PDF,
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );

    expect(parsed.text).toBe('Second page');
    expect(parsed.diagnostics).toEqual([
      { severity: 'warning', message: 'page 1 was not parsed completely' },
    ]);
  });

  it('parses Retry-After in seconds and HTTP-date form', () => {
    expect(retryAfterMs(new Response('', { headers: { 'retry-after': '2' } }))).toBe(2000);
    expect(retryAfterMs(new Response('', { headers: { 'retry-after': '1000' } }))).toBe(900000);
    expect(retryAfterMs(new Response(''))).toBeUndefined();
    expect(retryAfterMs(new Response('', { headers: { 'retry-after': 'soon' } }))).toBeUndefined();
    const future = new Date(Date.now() + 6000).toUTCString();
    const delay = retryAfterMs(new Response('', { headers: { 'retry-after': future } }))!;
    expect(delay).toBeGreaterThan(4000);
    expect(delay).toBeLessThanOrEqual(900000);
  });

  it('does not retry a poll before a Retry-After beyond the deadline', async () => {
    install({
      polls: [() => json({}, { status: 429, headers: { 'retry-after': '1000' } })],
    });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'test-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('beyond the');

    const cancel = calls().find((call) => call.init?.method === 'DELETE');
    expect(cancel?.url).toBe(`${MINICPM_OCR_DEFAULT_BASE}/document-parse/jobs/job-1`);
  });

  it('does not retry a submit before a Retry-After it will not wait for', async () => {
    install({
      submit: () => json({}, { status: 429, headers: { 'retry-after': '1000' } }),
      polls: [],
    });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'test-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('asked to retry after 900s');
    expect(transport.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('parses an image through the document extractor boundary as Markdown', async () => {
    install({
      polls: [
        () =>
          json({
            id: 'job-1',
            status: 'Success',
            pages_done: 1,
            pages_total: 1,
            markdown: '# Scanned page',
          }),
      ],
    });

    const provider = getDocumentExtractorProvider('minicpm-ocr');
    expect(provider).toBeDefined();
    const artifact = await provider!.extract({
      buffer: Buffer.from('png bytes'),
      fileName: 'scan.png',
      fileSize: 9,
      mimeType: 'image/png',
      config: { providerId: 'minicpm-ocr', apiKey: 'test-key', managed: true },
    });

    expect(artifact.blocks).toEqual([
      { id: 'document-text', type: 'markdown', text: '# Scanned page' },
    ]);
    expect(artifact.metadata).toMatchObject({ pageCount: 1, providerId: 'minicpm-ocr' });
  });

  it('assembles Markdown from pages when the self-hosted result has no top-level markdown', async () => {
    install({
      polls: [
        () =>
          json({
            id: 'job-1',
            status: 'Success',
            pages_done: 2,
            pages_total: 2,
            pages: [
              {
                metadata: { page_index: 1 },
                choices: [{ message: { content: 'Second' } }],
                minicpm_ocr: {
                  blocks: [{ label: 'table', content: '| C |', bbox: [0, 0, 10, 10] }],
                },
              },
              {
                metadata: { page_index: 0 },
                choices: [{ message: { content: 'First' } }],
                minicpm_ocr: {
                  blocks: [{ label: 'text', content: 'First', bbox: [1, 2, 11, 22] }],
                },
              },
            ],
          }),
      ],
    });

    const parsed = await parseWithMiniCPMOCR(
      {
        providerId: 'minicpm-ocr',
        baseUrl: 'http://127.0.0.1:8966/api',
        managed: true,
      },
      PDF,
      { fileName: 'scan.png', mimeType: 'image/png' },
    );

    expect(parsed.text).toBe('First\n\nSecond');
    expect(parsed.metadata?.pageCount).toBe(2);
    expect(parsed.layout).toEqual([
      { page: 1, type: 'text', content: 'First', position: { x: 1, y: 2, width: 10, height: 20 } },
      { page: 2, type: 'table', content: '| C |', position: { x: 0, y: 0, width: 10, height: 10 } },
    ]);
    // A self-hosted web demo takes no key, so none is sent.
    const [submit] = calls();
    expect(submit!.init?.headers).toEqual({});
  });

  it('never relays the provider error text or body', async () => {
    install({
      polls: [
        () =>
          json({
            id: 'job-1',
            status: 'Failed',
            error: 'failed at /srv/minicpm/config.yaml with token sk-secret',
          }),
      ],
    });

    const failure = parseWithMiniCPMOCR(
      { providerId: 'minicpm-ocr', apiKey: 'test-key', managed: true },
      PDF,
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );

    await expect(failure).rejects.toThrow('MiniCPM-OCR parsing failed');
    await expect(failure).rejects.not.toThrow(/sk-secret|\/srv\/minicpm/);
  });

  it('lets the PDF provider boundary send a keyless request to a self-hosted base URL', async () => {
    install({
      polls: [
        () =>
          json({
            id: 'job-1',
            status: 'Success',
            pages_done: 1,
            pages_total: 1,
            markdown: 'Local OCR',
          }),
      ],
    });

    const parsed = await parsePDF(
      { providerId: 'minicpm-ocr', baseUrl: 'http://127.0.0.1:8966/api', managed: true },
      PDF,
      { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
    );

    expect(parsed.text).toBe('Local OCR');
    expect(parsed.metadata?.parser).toBe('minicpm-ocr');
  });

  it('refuses a keyless request to the hosted API at the PDF provider boundary', async () => {
    await expect(parsePDF({ providerId: 'minicpm-ocr' }, PDF)).rejects.toThrow(
      'API key required for PDF provider: minicpm-ocr',
    );
    expect(transport.providerFetch).not.toHaveBeenCalled();
  });

  it('requires a key for the hosted API', async () => {
    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('API key required for the hosted MiniCPM-OCR API');
    expect(transport.providerFetch).not.toHaveBeenCalled();
  });

  it('refuses a rejected API key without retrying it', async () => {
    install({ submit: () => json({ error: 'invalid' }, { status: 401 }), polls: [] });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'bad-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('MiniCPM-OCR API key was rejected (HTTP 401)');
    expect(transport.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a submit answered with 5xx (the job may already exist)', async () => {
    install({
      submit: () => json({ error: 'bad gateway' }, { status: 502 }),
      polls: [],
    });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'test-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('MiniCPM-OCR job submission failed (HTTP 502)');
    expect(transport.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a submit whose transport failed (it may have been accepted)', async () => {
    install({
      submit: () => {
        throw new Error('fetch failed');
      },
      polls: [],
    });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'test-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('MiniCPM-OCR job submission failed: fetch failed');
    expect(transport.providerFetch).toHaveBeenCalledTimes(1);
  });

  it('stops when the caller aborts', async () => {
    install({ polls: [() => json({ id: 'job-1', status: 'Running' })] });
    const controller = new AbortController();
    controller.abort();

    await expect(
      parseWithMiniCPMOCR(
        { providerId: 'minicpm-ocr', apiKey: 'test-key', signal: controller.signal },
        PDF,
        { fileName: 'lesson.pdf', mimeType: 'application/pdf' },
      ),
    ).rejects.toThrow();
    expect(transport.providerFetch).not.toHaveBeenCalled();
  });

  it('fails a hosted probe that answers an error, but treats a self-hosted one as up', async () => {
    transport.providerFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      verifyMiniCPMOCRConnection({ baseUrl: 'http://127.0.0.1:8966/api' }),
    ).resolves.toEqual({ ok: true });

    transport.providerFetch.mockResolvedValueOnce(new Response(null, { status: 502 }));

    await expect(
      verifyMiniCPMOCRConnection({ apiKey: 'test-key', baseUrl: MINICPM_OCR_DEFAULT_BASE }),
    ).resolves.toEqual({ ok: false, reason: 'endpoint' });
  });

  it('bounds the response body', async () => {
    install({
      submit: () => {
        const chunk = { byteLength: 1024 } as unknown as Uint8Array;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'content-length': '999999999999' },
        });
      },
      polls: [],
    });

    await expect(
      parseWithMiniCPMOCR({ providerId: 'minicpm-ocr', apiKey: 'test-key' }, PDF, {
        fileName: 'lesson.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow('response exceeds');
  });
});
