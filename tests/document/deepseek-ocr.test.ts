/**
 * DeepSeek OCR as a document parser, driven through a stubbed transport: the
 * request it sends, the markdown it makes of the grounded page output, the
 * figures it crops (from a rendered PDF page and from an image), and how
 * failures are classified.
 */
import sharp from 'sharp';
import { PDFDocument, rgb } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ providerFetch: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/server/audio-provider-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/audio-provider-fetch')>();
  return { ...actual, audioProviderFetch: transport.providerFetch };
});

import {
  boxToPixels,
  deepseekOCRFailure,
  deepseekOCRToMarkdown,
  parseDeepSeekOCRPage,
  parseWithDeepSeekOCR,
} from '@/lib/pdf/deepseek-ocr';
import { parsePDF } from '@/lib/pdf/pdf-providers';
import {
  MaterialExtractionError,
  MaterialSourceRefusedError,
} from '@/lib/server/material-extraction/errors';

const R = (label: string, box: string, content: string) =>
  `<｜ref｜>${label}<｜/ref｜><｜box｜>${box}<｜/box｜> ${content}`;

/** The service streams keep-alive newlines, then the JSON result. */
function ocrResponse(pages: Array<{ text: string; finish_reason?: string }>, status = 200) {
  const json = JSON.stringify({
    id: 'ocr-1',
    object: 'ocr.result',
    created: 1,
    purpose: 'rich_layout_recognition',
    page_count: pages.length,
    pages: pages.map((page, index) => ({ index, finish_reason: 'stop', ...page })),
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
  return new Response(`\n\n\n${json}`, { status, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(message: string, status = 200) {
  return new Response(`\n\n${JSON.stringify({ error: { message, type: 'x', code: 'x' } })}`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  transport.providerFetch.mockReset();
});

describe('DeepSeek OCR page output', () => {
  it('splits a page into tagged blocks with boxes', () => {
    const blocks = parseDeepSeekOCRPage(
      [R('title', '[[341,183,659,209]]', 'Attention'), R('text', '[[1,2,3,4]]', 'Body\nmore')].join(
        '\n',
      ),
    );
    expect(blocks).toEqual([
      { label: 'title', boxes: [[341, 183, 659, 209]], content: 'Attention' },
      { label: 'text', boxes: [[1, 2, 3, 4]], content: 'Body\nmore' },
    ]);
    // Text extracted directly carries no tags.
    expect(parseDeepSeekOCRPage('Plain text')).toEqual([
      { label: 'text', boxes: [], content: 'Plain text' },
    ]);
    // The ASCII-bar `det` spelling of the open model is read too.
    expect(parseDeepSeekOCRPage('<|ref|>image<|/ref|><|det|>[[0,0,10,10]]<|/det|>')).toEqual([
      { label: 'image', boxes: [[0, 0, 10, 10]], content: '' },
    ]);
  });

  it('turns blocks into markdown and names figures by path', () => {
    const page = [
      R('header', '[[0,0,1000,20]]', 'Running header'),
      R('title', '[[0,30,1000,60]]', 'Results'),
      R('sub_title', '[[0,60,1000,80]]', '### 3.1 Setup'),
      R('text', '[[0,80,1000,120]]', 'We measure $x$.'),
      R('table', '[[0,120,1000,300]]', '<table><tr><td>a</td></tr></table>'),
      R('image', '[[100,300,900,700]]', ''),
      R('image_caption', '[[100,700,900,720]]', '<center>Figure 1: [The] model.</center>'),
      R('equation', '[[0,720,1000,760]]', '$$ E = mc^2 $$'),
      R('page_number', '[[480,960,520,980]]', '3'),
    ].join('\n');

    const { markdown, figures } = deepseekOCRToMarkdown([{ index: 2, text: page }], true);

    expect(markdown).toBe(
      [
        '## Results',
        '### 3.1 Setup',
        'We measure $x$.',
        '<table><tr><td>a</td></tr></table>',
        '![Figure 1: The model.](images/deepseek-ocr-p3-1.png)',
        'Figure 1: [The] model.',
        '$$ E = mc^2 $$',
      ].join('\n\n'),
    );
    expect(figures).toEqual([
      {
        pageIndex: 2,
        box: [100, 300, 900, 700],
        path: 'images/deepseek-ocr-p3-1.png',
        caption: 'Figure 1: [The] model.',
      },
    ]);

    // Without figure support (Word/PowerPoint), figures leave no reference.
    expect(deepseekOCRToMarkdown([{ index: 2, text: page }], false).figures).toEqual([]);
  });

  it('maps a normalized box onto pixels and skips slivers', () => {
    expect(boxToPixels([100, 200, 600, 800], 1000, 500)).toEqual({
      left: 100,
      top: 100,
      width: 500,
      height: 300,
    });
    expect(boxToPixels([0, 0, 5, 5], 1000, 1000)).toBeNull();
    // Out-of-range values clamp to the page.
    expect(boxToPixels([-10, 0, 1200, 1000], 200, 100)).toEqual({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
    });
  });
});

describe('parseWithDeepSeekOCR', () => {
  it('sends the file with the layout purpose and parses a keep-alive padded body', async () => {
    transport.providerFetch.mockResolvedValueOnce(
      ocrResponse([{ text: R('text', '[[0,0,1000,100]]', 'Hello') }]),
    );
    const docx = Buffer.from('PK\u0003\u0004 not really a docx');

    const result = await parsePDF({ providerId: 'deepseek-ocr', apiKey: 'sk-ds' }, docx, {
      fileName: 'notes.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const [url, init, policy] = transport.providerFetch.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/ocr');
    expect(init.headers.Authorization).toBe('Bearer sk-ds');
    const form = init.body as FormData;
    expect(form.get('purpose')).toBe('rich_layout_recognition');
    expect((form.get('file') as File).name).toBe('notes.docx');
    expect(policy).toMatchObject({ rejectRedirects: true, allowLocalNetworks: undefined });
    expect(result.text).toBe('Hello');
    expect(result.images).toEqual([]);
    expect(result.metadata).toMatchObject({ parser: 'deepseek-ocr', pageCount: 1 });
  });

  it('requires an API key', async () => {
    await expect(parsePDF({ providerId: 'deepseek-ocr' }, Buffer.from('%PDF-1.4'))).rejects.toThrow(
      'API key required',
    );
  });

  it('crops a figure out of an image upload', async () => {
    const png = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    transport.providerFetch.mockResolvedValueOnce(
      ocrResponse([{ text: R('image', '[[0,0,500,1000]]', '') }]),
    );

    const result = await parseWithDeepSeekOCR({ providerId: 'deepseek-ocr', apiKey: 'k' }, png, {
      fileName: 'chart.png',
      mimeType: 'image/png',
    });

    expect(result.text).toBe('![](images/deepseek-ocr-p1-1.png)');
    expect(result.metadata?.pdfImages).toMatchObject([
      { id: 'img_1', pageNumber: 1, width: 100, height: 100, path: 'images/deepseek-ocr-p1-1.png' },
    ]);
    const crop = Buffer.from(result.images[0]!.split(',')[1]!, 'base64');
    expect(await sharp(crop).metadata()).toMatchObject({ width: 100, height: 100 });
  });

  it('renders a PDF page and crops the figure region', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    page.drawRectangle({ x: 0, y: 200, width: 200, height: 200, color: rgb(0, 0, 1) });
    const pdf = Buffer.from(await doc.save());
    transport.providerFetch.mockResolvedValueOnce(
      ocrResponse([
        {
          text: [
            R('image', '[[0,0,500,500]]', ''),
            R('image_caption', '[[0,500,500,520]]', 'Figure 1: Blue'),
          ].join('\n'),
        },
      ]),
    );

    const result = await parseWithDeepSeekOCR({ providerId: 'deepseek-ocr', apiKey: 'k' }, pdf, {
      fileName: 'deck.pdf',
      mimeType: 'application/pdf',
    });

    expect(result.text).toBe('![Figure 1: Blue](images/deepseek-ocr-p1-1.png)\n\nFigure 1: Blue');
    expect(result.metadata?.pdfImages).toHaveLength(1);
    expect(result.metadata?.pdfImages?.[0]).toMatchObject({
      pageNumber: 1,
      description: 'Figure 1: Blue',
    });
    const crop = Buffer.from(result.images[0]!.split(',')[1]!, 'base64');
    const { dominant } = await sharp(crop).stats();
    expect(dominant.b).toBeGreaterThan(200);
    expect(dominant.r).toBeLessThan(50);
  });

  it('skips cropping when the caller wants text only', async () => {
    const png = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    transport.providerFetch.mockResolvedValueOnce(
      ocrResponse([
        { text: `${R('image', '[[0,0,1000,1000]]', '')}\n${R('text', '[[0,0,1,1]]', 'T')}` },
      ]),
    );

    const result = await parseWithDeepSeekOCR(
      { providerId: 'deepseek-ocr', apiKey: 'k', textOnly: true },
      png,
    );

    expect(result.text).toBe('T');
    expect(result.images).toEqual([]);
  });

  it('refuses a document over the page limit as the source, not retried', async () => {
    transport.providerFetch.mockResolvedValueOnce(
      errorResponse('Failed to recognize the file: the document has more than 1000 pages'),
    );

    const error = await parseWithDeepSeekOCR(
      { providerId: 'deepseek-ocr', apiKey: 'k' },
      Buffer.from('%PDF-1.4'),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(MaterialSourceRefusedError);
    expect(error.reasonCode).toBe('too_many_pages');
    expect(error.reasonValues).toEqual({ maxPages: 1000 });
  });

  it('marks a busy service retryable and a bad key or broken file not', () => {
    const busy = deepseekOCRFailure(
      undefined,
      'The OCR service is temporarily unavailable. Please try again later.',
    );
    expect(busy).toBeInstanceOf(MaterialExtractionError);
    expect((busy as MaterialExtractionError).retryable).toBe(true);
    expect((deepseekOCRFailure(429, '') as MaterialExtractionError).retryable).toBe(true);

    const auth = deepseekOCRFailure(401, 'Authentication Fails');
    expect((auth as MaterialExtractionError).retryable).toBe(false);
    expect(auth.message).toBe('DeepSeek OCR failed (HTTP 401): Authentication Fails');
    const password = deepseekOCRFailure(undefined, 'The file is password-protected');
    expect((password as MaterialExtractionError).retryable).toBe(false);
  });

  it('surfaces an HTTP error with the provider message', async () => {
    transport.providerFetch.mockResolvedValueOnce(errorResponse('Insufficient Balance', 402));

    await expect(
      parseWithDeepSeekOCR({ providerId: 'deepseek-ocr', apiKey: 'k' }, Buffer.from('%PDF-1.4')),
    ).rejects.toThrow('DeepSeek OCR failed (HTTP 402): Insufficient Balance');
  });
});
