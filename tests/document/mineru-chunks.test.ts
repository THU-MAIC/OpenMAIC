import { parseMinerUPdfChunks } from '@/lib/pdf/mineru-chunks';
import { documentExtractionFailure } from '@/lib/server/material-extraction/extract';
import { readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import * as imageParser from '@/lib/server/material-extraction/document-image-parser';
import { randomBytes } from 'node:crypto';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pdfDocumentExtractorProviders } from '@/lib/document/extractors/pdf';
import { mergeMinerUChunks } from '@/lib/pdf/mineru-chunks';
import { parseWithMinerUDocument } from '@/lib/pdf/pdf-providers';
import { providerFetch } from '@/lib/server/provider-fetch';
import {
  isTransientExtractionError,
  MaterialSourceRefusedError,
} from '@/lib/server/material-extraction/errors';

vi.mock('@/lib/server/provider-fetch', () => ({ providerFetch: vi.fn() }));
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

const fetchMock = vi.mocked(providerFetch);
const config = { providerId: 'mineru' as const, baseUrl: 'https://parser.example', managed: true };
const options = { fileName: 'original.pdf', mimeType: 'application/pdf' };
const fileOf = (init: RequestInit) => (init.body as FormData).get('files') as File;
const response = (result: Record<string, unknown> = { md_content: 'parsed' }) =>
  Response.json({ results: { server_filename: result } });

async function pdf(pages: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index++) document.addPage([100 + index, 200]);
  return Buffer.from(await document.save());
}

beforeEach(() => {
  warn.mockClear();
  fetchMock.mockReset().mockImplementation(async () => response());
  vi.stubEnv('PDF_MINERU_MAX_PAGES', '1000');
  vi.stubEnv('PDF_MINERU_CHUNK_PAGES', '2');
  vi.stubEnv('PDF_MINERU_CHUNK_CONCURRENCY', '2');
  vi.stubEnv('PDF_MINERU_BACKEND', 'pipeline');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('self-hosted MinerU PDF chunks', () => {
  it('releases the source PDF while the last parse requests are still pending', async () => {
    vi.stubEnv('PDF_MINERU_CHUNK_CONCURRENCY', '4');
    const bytes = await pdf(6);
    let source: WeakRef<PDFDocument> | undefined;
    const load = PDFDocument.load;
    const loadSpy = vi.spyOn(PDFDocument, 'load').mockImplementation(async (...args) => {
      const document = await load(...args);
      source = new WeakRef(document);
      return document;
    });
    let release!: () => void;
    let dispatched!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const allDispatched = new Promise<void>((resolve) => (dispatched = resolve));
    let calls = 0;
    const job = parseMinerUPdfChunks(bytes, async (_bytes, name) => {
      if (++calls === 3) dispatched();
      await pending;
      return { md_content: name };
    });
    try {
      await allDispatched;
      // The spy's recorded result would itself keep the loaded document alive.
      loadSpy.mockClear();
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      setFlagsFromString('--no-expose-gc');
      for (let round = 0; round < 3; round++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
      }
      expect(source).toBeDefined();
      expect(source!.deref()).toBeUndefined();
    } finally {
      release();
      await job;
    }
    expect((await job)?.text).toBe('pages-1-2.pdf\n\npages-3-4.pdf\n\npages-5-6.pdf');
  });

  it('also chunks PDFs sent directly through the document extractor', async () => {
    const extractor = pdfDocumentExtractorProviders.find((provider) => provider.id === 'mineru')!;
    fetchMock.mockImplementation(async (_url, init) =>
      response({ md_content: fileOf(init!).name, content_list: [{ page_idx: 0 }] }),
    );
    const artifact = await extractor.extract({ buffer: await pdf(3), ...options, config });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(artifact.blocks[0]).toMatchObject({
      type: 'markdown',
      text: 'pages-1-2.pdf\n\npages-3-3.pdf',
    });
  });
  it.each([1, 2])('keeps the original request and full result for %i pages', async (pages) => {
    const bytes = await pdf(pages);
    const signal = new AbortController().signal;
    fetchMock.mockResolvedValue(
      response({
        md_content: '![figure](images/a.png)',
        images: { 'a.png': 'data:image/png;base64,abc' },
        content_list: JSON.stringify([
          {
            type: 'image',
            page_idx: 0,
            img_path: 'images/a.png',
            bbox: [1, 2, 11, 22],
            image_caption: ['caption'],
          },
        ]),
      }),
    );
    const result = await parseWithMinerUDocument(
      { ...config, apiKey: 'test-key', signal },
      bytes,
      options,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init, policy] = fetchMock.mock.calls[0];
    expect(url).toBe('https://parser.example/file_parse');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      signal,
    });
    expect(policy).toEqual({ allowLocalNetworks: true, rejectRedirects: true });
    const form = init!.body as FormData;
    expect([...form.keys()]).toEqual([
      'files',
      'parse_method',
      'backend',
      'return_content_list',
      'return_images',
    ]);
    expect(Object.fromEntries([...form.entries()].filter(([key]) => key !== 'files'))).toEqual({
      parse_method: 'auto',
      backend: 'pipeline',
      return_content_list: 'true',
      return_images: 'true',
    });
    const file = fileOf(init!);
    expect(file.name).toBe(options.fileName);
    expect(file.type).toBe(options.mimeType);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
    // Transient chapter evidence is not part of the serialized parser result.
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      text: '![figure](images/a.png)',
      images: ['data:image/png;base64,abc'],
      metadata: {
        parser: 'mineru',
        textFormat: 'markdown',
        pageCount: 1,
        imageMapping: { img_1: 'data:image/png;base64,abc' },
        pdfImages: [
          {
            id: 'img_1',
            src: 'data:image/png;base64,abc',
            pageNumber: 1,
            description: 'caption',
            width: 10,
            height: 20,
            path: 'a.png',
          },
        ],
      },
    });
  });

  it('copies exact page ranges, including the short final chunk, without changing source bytes', async () => {
    const bytes = await pdf(5);
    const original = Buffer.from(bytes);
    const received: Record<string, number[]> = {};
    fetchMock.mockImplementation(async (_url, init) => {
      const file = fileOf(init!);
      const document = await PDFDocument.load(await file.arrayBuffer());
      received[file.name] = document.getPages().map((page) => page.getWidth());
      return response({
        md_content: file.name,
        content_list: document.getPages().map((_, page_idx) => ({ page_idx })),
      });
    });
    const result = await parseWithMinerUDocument(config, bytes, options);
    expect(received).toEqual({
      'pages-1-2.pdf': [100, 101],
      'pages-3-4.pdf': [102, 103],
      'pages-5-5.pdf': [104],
    });
    expect(result.text).toBe('pages-1-2.pdf\n\npages-3-4.pdf\n\npages-5-5.pdf');
    expect(result.metadata?.pageCount).toBe(5);
    expect(bytes).toEqual(original);
  });

  it('removes GoTo/Dest links before copying, keeps URI links, and does not copy linked page payloads', async () => {
    const document = await PDFDocument.create();
    const pages = Array.from({ length: 6 }, () => document.addPage());
    for (const [index, page] of pages.entries()) {
      // A unique uncompressed image per page makes accidental page-graph copying measurable.
      const image = document.context.register(
        document.context.stream(randomBytes(96 * 96 * 3), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 96,
          Height: 96,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
        }),
      );
      page.node.set(PDFName.of('Resources'), document.context.obj({ XObject: { Figure: image } }));
      const destination = [pages[(index + 1) % pages.length].ref, PDFName.of('Fit')];
      const annotations = [
        { Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], Dest: destination },
        { Type: 'Annot', Subtype: 'Link', Rect: [0, 10, 10, 20], A: { S: 'GoTo', D: destination } },
        {
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [0, 20, 10, 30],
          P: page.ref,
          A: { S: 'URI', URI: PDFString.of('https://example.org/reference') },
        },
      ].map((annotation) => document.context.register(document.context.obj(annotation)));
      page.node.set(PDFName.of('Annots'), document.context.obj(annotations));
    }
    const bytes = Buffer.from(await document.save());
    let totalBytes = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      const file = fileOf(init!);
      totalBytes += file.size;
      const chunk = await PDFDocument.load(await file.arrayBuffer());
      expect(chunk.getPageCount()).toBe(2);
      for (const page of chunk.getPages()) {
        const annotations = page.node.Annots()!;
        expect(annotations.size()).toBe(1);
        const annotation = annotations.lookup(0, PDFDict);
        expect(annotation.has(PDFName.of('Dest'))).toBe(false);
        expect(annotation.get(PDFName.of('P'))).toBe(page.ref);
        const action = annotation.lookup(PDFName.of('A'), PDFDict);
        expect(action.get(PDFName.of('S'))).toBe(PDFName.of('URI'));
        expect(action.lookup(PDFName.of('URI'), PDFString).decodeText()).toBe(
          'https://example.org/reference',
        );
      }
      return response();
    });
    await parseWithMinerUDocument(config, bytes, options);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(totalBytes / bytes.length).toBeLessThan(1.1);
    expect((await PDFDocument.load(bytes)).getPages()[0].node.Annots()?.size()).toBe(3);
  });

  it('bounds in-flight requests while merging out-of-order completions in page order', async () => {
    const pending = new Map<string, () => void>();
    let active = 0;
    let maximum = 0;
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((resolve) => {
          const file = fileOf(init!);
          maximum = Math.max(maximum, ++active);
          pending.set(file.name, () => {
            active--;
            resolve(response({ md_content: file.name }));
          });
        }),
    );
    const parsing = parseWithMinerUDocument(config, await pdf(7), options);
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get('pages-3-4.pdf')!();
    await vi.waitFor(() => expect(pending.size).toBe(3));
    pending.get('pages-5-6.pdf')!();
    await vi.waitFor(() => expect(pending.size).toBe(4));
    pending.get('pages-7-7.pdf')!();
    pending.get('pages-1-2.pdf')!();
    expect((await parsing).text).toBe(
      'pages-1-2.pdf\n\npages-3-4.pdf\n\npages-5-6.pdf\n\npages-7-7.pdf',
    );
    expect(maximum).toBe(2);
    expect(active).toBe(0);
  });

  it('defaults to 50 pages per chunk and four active requests', async () => {
    vi.stubEnv('PDF_MINERU_CHUNK_PAGES', '');
    vi.stubEnv('PDF_MINERU_CHUNK_CONCURRENCY', '');
    const pending: Array<() => void> = [];
    const names: string[] = [];
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((resolve) => {
          names.push(fileOf(init!).name);
          pending.push(() => resolve(response()));
        }),
    );
    const parsing = parseWithMinerUDocument(config, await pdf(201), options);
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect(names.sort()).toEqual([
      'pages-1-50.pdf',
      'pages-101-150.pdf',
      'pages-151-200.pdf',
      'pages-51-100.pdf',
    ]);
    pending[0]();
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    expect(names[4]).toBe('pages-201-201.pdf');
    pending.slice(1).forEach((finish) => finish());
    await parsing;
  });

  it('retries only the failed chunk once and returns a complete result', async () => {
    const counts = new Map<string, number>();
    fetchMock.mockImplementation(async (_url, init) => {
      const name = fileOf(init!).name;
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      return name === 'pages-3-4.pdf' && count === 1
        ? new Response('', { status: 503 })
        : response({ md_content: name });
    });
    const result = await parseWithMinerUDocument(config, await pdf(5), options);
    expect(Object.fromEntries(counts)).toEqual({
      'pages-1-2.pdf': 1,
      'pages-3-4.pdf': 2,
      'pages-5-5.pdf': 1,
    });
    expect(result.text).toBe('pages-1-2.pdf\n\npages-3-4.pdf\n\npages-5-5.pdf');
  });

  it('fails the whole document with a 1-based range after two failures and preserves existing classification', async () => {
    vi.stubEnv('PDF_MINERU_CHUNK_CONCURRENCY', '1');
    fetchMock.mockImplementation(async (_url, init) =>
      fileOf(init!).name === 'pages-1-2.pdf' ? response() : new Response('', { status: 503 }),
    );
    const error = await parseWithMinerUDocument(config, await pdf(7), options).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'PDF pages 3–4 after two attempts: MinerU API error (503)',
    );
    expect(isTransientExtractionError(error)).toBe(false);
    expect(error).toMatchObject({
      reasonCode: 'pages_failed',
      reasonValues: { firstPage: 3, lastPage: 4 },
      retryable: false,
    });
    expect(error).not.toBeInstanceOf(MaterialSourceRefusedError);
    expect(fetchMock.mock.calls.map(([, init]) => fileOf(init!).name)).toEqual([
      'pages-1-2.pdf',
      'pages-3-4.pdf',
      'pages-3-4.pdf',
    ]);
  });

  it('keeps a service page-limit refusal and suggests reducing chunk size', async () => {
    vi.stubEnv('PDF_MINERU_CHUNK_CONCURRENCY', '1');
    fetchMock.mockImplementation(async () =>
      Response.json(
        {
          error: {
            code: 'pdf_too_many_pages',
            message: 'PDF has 2 pages, which exceeds the 1-page limit',
          },
        },
        { status: 422 },
      ),
    );
    const error = await parseWithMinerUDocument(config, await pdf(3), options).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(MaterialSourceRefusedError);
    expect(error).toMatchObject({
      reasonCode: 'too_many_pages',
      reasonValues: { pages: 2, maxPages: 1 },
      retryable: false,
    });
    expect((error as Error).message).toContain('PDF pages 1–2');
    expect((error as Error).message).toContain('PDF_MINERU_CHUNK_PAGES exceeds');
    expect((error as Error).message).toContain('after one attempt');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts every active request without retrying or dispatching later chunks', async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          signals.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const parsing = parseWithMinerUDocument(
      { ...config, signal: controller.signal },
      await pdf(9),
      options,
    );
    const rejected = expect(parsing).rejects.toThrow('upload cancelled');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    controller.abort(new Error('upload cancelled'));
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels and drains sibling requests when a chunk exhausts its retry', async () => {
    let fail: (() => void) | undefined;
    let siblingSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      if (fileOf(init!).name === 'pages-1-2.pdf') {
        if (fail) return Promise.resolve(new Response('', { status: 503 }));
        return new Promise((resolve) => {
          fail = () => resolve(new Response('', { status: 503 }));
        });
      }
      siblingSignal = init!.signal!;
      return new Promise((_resolve, reject) => {
        siblingSignal!.addEventListener('abort', () => reject(siblingSignal!.reason), {
          once: true,
        });
      });
    });
    const parsing = parseWithMinerUDocument(config, await pdf(7), options);
    const rejected = expect(parsing).rejects.toThrow('MinerU API error (503)');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fail!();
    await rejected;
    expect(siblingSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['4', 5, 4],
    ['', 1001, 1000],
  ])('rejects above the total page cap %s before HTTP', async (limit, pages, maxPages) => {
    vi.stubEnv('PDF_MINERU_MAX_PAGES', limit);
    await expect(parseWithMinerUDocument(config, await pdf(pages), options)).rejects.toMatchObject({
      reasonCode: 'too_many_pages',
      reasonValues: { pages, maxPages },
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ])('leaves %s whole', async (mimeType) => {
    const bytes = await pdf(5);
    await parseWithMinerUDocument(config, bytes, { fileName: 'office-file', mimeType });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const file = fileOf(fetchMock.mock.calls[0][1]!);
    expect(file.name).toBe('office-file');
    expect(file.type).toBe(mimeType);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);
  });

  it.each(['corrupt', 'encrypted'])(
    'falls back to original bytes for an unreadable %s PDF',
    async (kind) => {
      let bytes = Buffer.from('not a readable PDF');
      if (kind === 'encrypted') {
        const document = await PDFDocument.load(await pdf(5));
        document.context.trailerInfo.Encrypt = document.context.register(
          document.context.obj({ Filter: 'Standard', V: 1, R: 2 }),
        );
        bytes = Buffer.from(await document.save());
        await expect(PDFDocument.load(bytes)).rejects.toThrow('encrypted');
      }
      await parseWithMinerUDocument(config, bytes, options);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Buffer.from(await fileOf(fetchMock.mock.calls[0][1]!).arrayBuffer())).toEqual(bytes);
    },
  );

  it.each(['0', '-1', '1.5', 'NaN'])('rejects invalid chunk configuration %s', async (value) => {
    vi.stubEnv('PDF_MINERU_CHUNK_PAGES', value);
    await expect(parseWithMinerUDocument(config, await pdf(3), options)).rejects.toThrow(
      'PDF_MINERU_CHUNK_PAGES must be a positive integer',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MinerU chunk merge', () => {
  it('namespaces repeated image paths, rewrites actual image references, and offsets image pages', async () => {
    const chunk = (startPage: number) => ({
      startPage,
      result: {
        md_content: `page ${startPage + 1}\n![inline](images/same.png)\n<img src="same.png">\n![ref][figure]\n\n[figure]: images/same.png\n\n\`![code](images/same.png)\`\nprose images/same.png`,
        images: { 'same.png': `data:image/png;base64,${startPage}` },
        content_list: JSON.stringify([
          {
            type: 'image',
            page_idx: 1,
            img_path: 'images/same.png',
            bbox: [0, 0, 10, 20],
            image_caption: [`caption ${startPage}`],
          },
          { type: 'text', page_idx: 1 },
        ]),
      },
    });
    const result = await mergeMinerUChunks([chunk(2), chunk(0)]);
    expect(result.text.startsWith('page 1')).toBe(true);
    expect(result.text.indexOf('page 3')).toBeGreaterThan(result.text.indexOf('page 1'));
    expect(result.metadata?.pageCount).toBe(2); // Two distinct reported pages; absent blank pages are not invented.
    expect(
      result.metadata?.pdfImages?.map(({ id, pageNumber, path, description }) => ({
        id,
        pageNumber,
        path,
        description,
      })),
    ).toEqual([
      { id: 'img_1', pageNumber: 2, path: 'images/chunk-1/image-1', description: 'caption 0' },
      { id: 'img_2', pageNumber: 4, path: 'images/chunk-3/image-1', description: 'caption 2' },
    ]);
    expect(result.images).toEqual(['data:image/png;base64,0', 'data:image/png;base64,2']);
    for (const start of [1, 3]) {
      expect(result.text).toContain(`![inline](images/chunk-${start}/image-1)`);
      expect(result.text).toContain(`<img src="images/chunk-${start}/image-1">`);
      expect(result.text).toContain(`![ref](images/chunk-${start}/image-1)`);
    }
    expect(result.text.match(/`!\[code\]\(images\/same.png\)`/g)).toHaveLength(2);
    expect(result.text.match(/prose images\/same.png/g)).toHaveLength(2);
  });

  it('leaves out equation crops whose LaTeX each chunk already has in its text', async () => {
    const chunk = (startPage: number) => ({
      startPage,
      result: {
        md_content: `$$x + ${startPage}$$\n\n![figure](images/fig.png)`,
        images: { 'eq.png': 'data:image/png;base64,EQ', 'fig.png': 'data:image/png;base64,FIG' },
        content_list: [
          {
            type: 'equation',
            img_path: 'images/eq.png',
            page_idx: 0,
            text: `$$x + ${startPage}$$`,
          },
          { type: 'image', img_path: 'images/fig.png', page_idx: 0 },
        ],
      },
    });
    const result = await mergeMinerUChunks([chunk(0), chunk(2)]);
    expect(
      result.metadata?.pdfImages?.map(({ path, pageNumber }) => ({ path, pageNumber })),
    ).toEqual([
      { path: 'images/chunk-1/image-2', pageNumber: 1 },
      { path: 'images/chunk-3/image-2', pageNumber: 3 },
    ]);
    expect(result.text).toContain('![figure](images/chunk-3/image-2)');
  });

  it('keeps an equation crop a chunk names, matched by its own chunk path', async () => {
    const result = await mergeMinerUChunks([
      {
        startPage: 0,
        result: {
          md_content: '![](images/fig.png)',
          images: { 'fig.png': 'data:image/png;base64,FIG' },
          content_list: [{ type: 'image', img_path: 'images/fig.png', page_idx: 0 }],
        },
      },
      {
        startPage: 2,
        result: {
          md_content: '$$x$$\n\n![](images/named.png)',
          images: {
            'eq.png': 'data:image/png;base64,EQ',
            'named.png': 'data:image/png;base64,NAMED',
          },
          content_list: [
            { type: 'equation', img_path: 'images/eq.png', page_idx: 0, text: '$$x + 1$$' },
            { type: 'equation', img_path: 'images/named.png', page_idx: 0, text: '$$x + 2$$' },
          ],
        },
      },
    ]);
    // `images/chunk-1/image-1` shares its file name with chunk 3's equation
    // crop; only chunk 3's own paths decide.
    expect(result.metadata?.pdfImages?.map(({ path }) => path)).toEqual([
      'images/chunk-1/image-1',
      'images/chunk-3/image-2',
    ]);
  });

  it('handles URL-backed images and optional missing or malformed content lists', async () => {
    const result = await mergeMinerUChunks([
      {
        startPage: 2,
        result: {
          md_content: '![figure](https://images.example/a.png)',
          images: { img_1: 'https://images.example/a.png' },
          content_list: [{ type: 'image', page_idx: 0, img_path: 'https://images.example/a.png' }],
        },
      },
      { startPage: 0, result: { md_content: 'first', content_list: '{invalid' } },
      { startPage: 4, result: { md_content: 'last' } },
    ]);
    expect(result.text).toBe('first\n\n![figure](images/chunk-3/image-1)\n\nlast');
    expect(result.metadata?.pdfImages?.[0]).toMatchObject({
      src: 'https://images.example/a.png',
      pageNumber: 3,
    });
    expect(result.metadata?.pageCount).toBe(1);
  });
});

it.each([
  Object.assign(new Error('Cannot connect to the parsing service'), { code: 'ECONNREFUSED' }),
  Object.assign(new Error('Authentication failed'), { status: 401 }),
  new Error('MinerU API error (status 503)'),
])(
  'preserves the original error and failure classification before any chunk succeeds: %s',
  async (original) => {
    vi.stubEnv('PDF_MINERU_CHUNK_CONCURRENCY', '1');
    const parse = vi.fn().mockRejectedValue(original);
    const error = await parseMinerUPdfChunks(await pdf(5), parse).catch((error: unknown) => error);
    expect(error).toBe(original);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(isTransientExtractionError(error)).toBe(isTransientExtractionError(original));
    expect(documentExtractionFailure([original.message], [error])).toEqual(
      documentExtractionFailure([original.message], [original]),
    );
    expect(error).not.toHaveProperty('reasonCode', 'pages_failed');
  },
);

it.each([false, true])(
  'preserves real image paths regardless of key order (reverse=%s)',
  async (reverse) => {
    const entries = [
      ['images/a.png', 'data:image/png;base64,NESTED'],
      ['a.png', 'data:image/png;base64,ROOT'],
    ];
    if (reverse) entries.reverse();
    const result = await mergeMinerUChunks([
      {
        startPage: 0,
        result: {
          md_content: '![nested](images/a.png)\n![root](a.png)\n![ambiguous](other/a.png)',
          images: Object.fromEntries(entries),
          content_list: [
            { type: 'image', img_path: 'images/a.png', page_idx: 0 },
            { type: 'image', img_path: 'a.png', page_idx: 1 },
          ],
        },
      },
    ]);
    const nested = reverse ? 2 : 1;
    const root = reverse ? 1 : 2;
    expect(result.text).toBe(
      `![nested](images/chunk-1/image-${nested})\n![root](images/chunk-1/image-${root})\n![ambiguous](other/a.png)`,
    );
    expect(
      result.metadata?.pdfImages?.find((image) => image.src.endsWith('NESTED'))?.pageNumber,
    ).toBe(1);
    expect(
      result.metadata?.pdfImages?.find((image) => image.src.endsWith('ROOT'))?.pageNumber,
    ).toBe(2);
  },
);

describe('bounded chunk image parsing', () => {
  const chunk = (startPage: number, text = '![figure](images/a.png)') => ({
    startPage,
    result: {
      md_content: text,
      images: { 'a.png': `data:image/png;base64,${startPage}` },
      content_list: [{ type: 'image', img_path: 'images/a.png', page_idx: 0 }],
    },
  });

  it.each([
    ['input bytes', 'x'.repeat(4 * 1024 * 1024 + 1)],
    ['HTML density', '<span>x</span>'.repeat(50_001)],
  ])('keeps text and omits only rejected chunk images on excess %s', async (_kind, oversized) => {
    const worker = vi.spyOn(imageParser, 'runDocumentImageWorker');
    const text = oversized + '\n![unresolved](images/a.png)';
    const result = await mergeMinerUChunks([chunk(0), chunk(2, text), chunk(4)]);
    // Compare without printing multi-megabyte document contents on failure.
    expect(
      result.text ===
        `![figure](images/chunk-1/image-1)\n\n${text}\n\n![figure](images/chunk-5/image-1)`,
    ).toBe(true);
    expect(result.images).toEqual(['data:image/png;base64,0', 'data:image/png;base64,4']);
    expect(
      result.metadata?.pdfImages?.map(({ path, pageNumber }) => ({ path, pageNumber })),
    ).toEqual([
      { path: 'images/chunk-1/image-1', pageNumber: 1 },
      { path: 'images/chunk-5/image-1', pageNumber: 5 },
    ]);
    expect(result.metadata?.pageCount).toBe(3);
    expect(worker).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Chunk image rewriting failed; keeping text without chunk images',
      { firstPage: 3, errorType: 'DocumentImageParseError' },
    );
  });

  it('skips the worker for chunks without images, even above the input budget', async () => {
    const worker = vi.spyOn(imageParser, 'runDocumentImageWorker');
    const text = 'x'.repeat(4 * 1024 * 1024 + 1);
    expect((await mergeMinerUChunks([{ startPage: 0, result: { md_content: text } }])).text).toBe(
      text,
    );
    expect(worker).not.toHaveBeenCalled();
  });

  it('propagates cancellation while waiting for the real image worker', async () => {
    const worker = vi.spyOn(imageParser, 'runDocumentImageWorker');
    const controller = new AbortController();
    const merging = mergeMinerUChunks([chunk(0), chunk(2)], undefined, controller.signal);
    const rejected = expect(merging).rejects.toThrow('aborted');
    expect(worker).toHaveBeenCalledExactlyOnceWith(
      { kind: 'plan', text: chunk(0).result.md_content, includeAllTargets: true },
      undefined,
      controller.signal,
    );
    controller.abort();
    await rejected;
    expect(worker).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes the chunk signal to the worker and awaits its cancellation', async () => {
    const controller = new AbortController();
    const error = new Error('image parsing cancelled');
    let receivedSignal: AbortSignal | undefined;
    const worker = vi.spyOn(imageParser, 'runDocumentImageWorker').mockImplementation(
      (_job: unknown, _key?: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          receivedSignal = signal;
          signal!.addEventListener('abort', () => reject(error), { once: true });
        }),
    );
    const parsing = parseMinerUPdfChunks(
      await pdf(3),
      async () => chunk(0).result,
      controller.signal,
    );
    const rejected = expect(parsing).rejects.toBe(error);
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
    expect(worker).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'plan' }),
      undefined,
      receivedSignal,
    );
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    await rejected;
    expect(receivedSignal?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    new imageParser.DocumentImageParseError(
      new Error('Document image parse queue wait exceeded 30s'),
    ),
    new imageParser.DocumentImageParseError(new Error('Document image parse exceeded 30s')),
    new imageParser.DocumentImageParseError(new Error('worker failed')),
    new Error('unexpected worker failure'),
    'non-Error worker failure',
  ])('keeps a fully parsed book when image merging fails: %s', async (error) => {
    // One middle chunk fails; surrounding chunks still use the real image worker.
    const realWorker = imageParser.runDocumentImageWorker;
    const worker = vi
      .spyOn(imageParser, 'runDocumentImageWorker')
      .mockImplementationOnce(realWorker)
      .mockRejectedValueOnce(error);
    const parse = vi.fn(async (_bytes: Buffer, name: string) => {
      const start = Number(/^pages-(\d+)/.exec(name)![1]) - 1;
      return chunk(start).result;
    });
    const result = (await parseMinerUPdfChunks(await pdf(6), parse))!;
    expect(parse).toHaveBeenCalledTimes(3);
    expect(worker).toHaveBeenCalledTimes(3);
    expect(result.text).toBe(
      '![figure](images/chunk-1/image-1)\n\n![figure](images/a.png)\n\n![figure](images/chunk-5/image-1)',
    );
    expect(result.images).toEqual(['data:image/png;base64,0', 'data:image/png;base64,4']);
    expect(result.metadata?.pageCount).toBe(3);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Chunk image rewriting failed; keeping text without chunk images',
      { firstPage: 3, errorType: error instanceof Error ? error.name : 'UnknownError' },
    );
  });

  it('does not turn an explicit worker AbortError into a successful parse', async () => {
    const error = new DOMException('cancelled', 'AbortError');
    vi.spyOn(imageParser, 'runDocumentImageWorker').mockRejectedValue(error);
    await expect(mergeMinerUChunks([chunk(0), chunk(2)])).rejects.toBe(error);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not import a synchronous Markdown or HTML parser into chunk merging', () => {
    const source = readFileSync('lib/pdf/mineru-chunks.ts', 'utf8');
    expect(source).not.toMatch(
      /(?:from\s*|import\s*\()\s*['"][^'"]*(?:document-image-plan|parse5|mdast-util-from-markdown)/,
    );
    expect(source).not.toMatch(/\bimagePlan\s*\(/);
  });
});
