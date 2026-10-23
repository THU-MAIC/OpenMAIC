import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { parseWithPaddleOCR, PADDLEOCR_CONNECTION_FAILED } from '@/lib/pdf/paddleocr';

function pdfBuffer(): Buffer {
  return Buffer.from('%PDF-test');
}

function jsonBody(obj: unknown) {
  return new Response(JSON.stringify(obj), { status: 200 });
}

describe('PaddleOCR self-hosted (PaddleX serving)', () => {
  beforeEach(() => {
    transport.providerFetch.mockReset();
  });

  it('posts base64 + fileType to /layout-parsing and joins the per-page markdown', async () => {
    transport.providerFetch.mockResolvedValueOnce(
      jsonBody({
        errorCode: 0,
        errorMsg: 'Success',
        result: {
          layoutParsingResults: [
            { markdown: { text: '第一页内容' } },
            { markdown: { text: '第二页内容', images: { fig1: 'AAEC' } } },
          ],
        },
      }),
    );

    const result = await parseWithPaddleOCR(
      { providerId: 'paddleocr', baseUrl: 'http://paddle.example:8080' },
      pdfBuffer(),
    );

    const [url, init] = transport.providerFetch.mock.calls[0];
    expect(url).toBe('http://paddle.example:8080/layout-parsing');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.fileType).toBe(0);
    expect(body.file).toBe(pdfBuffer().toString('base64'));

    expect(result.text).toBe('第一页内容\n\n第二页内容');
    expect(result.images).toEqual(['data:image/png;base64,AAEC']);
    expect(result.metadata?.pageCount).toBe(2);
    expect(result.metadata?.parser).toBe('paddleocr');
    // The provider's own file reference is preserved so the owner rewrite can
    // match the markdown citation, and the page is the entry's, not the index.
    expect(result.metadata?.pdfImages?.[0]).toMatchObject({
      id: 'img_1',
      path: 'fig1',
      pageNumber: 2,
    });
  });

  it('runs a server-managed root with local networks allowed', async () => {
    transport.providerFetch.mockResolvedValueOnce(
      jsonBody({ errorCode: 0, result: { layoutParsingResults: [{ markdown: { text: 'x' } }] } }),
    );

    await parseWithPaddleOCR(
      { providerId: 'paddleocr', baseUrl: 'http://127.0.0.1:8080', managed: true },
      pdfBuffer(),
    );

    const policy = transport.providerFetch.mock.calls[0][2];
    expect(policy).toEqual({ allowLocalNetworks: true, rejectRedirects: true });
  });

  it('surfaces the serving error message on a non-zero errorCode', async () => {
    transport.providerFetch.mockResolvedValueOnce(
      jsonBody({ errorCode: 500, errorMsg: 'model not loaded' }),
    );

    await expect(
      parseWithPaddleOCR(
        { providerId: 'paddleocr', baseUrl: 'http://paddle.example' },
        pdfBuffer(),
      ),
    ).rejects.toThrow('model not loaded');
  });

  it('reports connection failures as a fixed message', async () => {
    transport.providerFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      parseWithPaddleOCR(
        { providerId: 'paddleocr', baseUrl: 'http://127.0.0.1:8080' },
        pdfBuffer(),
      ),
    ).rejects.toThrow(PADDLEOCR_CONNECTION_FAILED);
  });

  it('requires a base URL', async () => {
    await expect(parseWithPaddleOCR({ providerId: 'paddleocr' }, pdfBuffer())).rejects.toThrow(
      'PaddleOCR base URL is required',
    );
    expect(transport.providerFetch).not.toHaveBeenCalled();
  });
});
