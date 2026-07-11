import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('MinerU Cloud document upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves supported Office filename extensions for Cloud type inference', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# Parsed lesson');
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const batchBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/file-urls/batch')) {
        batchBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              batch_id: 'batch-1',
              file_urls: ['https://upload.example/lesson.docx'],
            },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://upload.example/lesson.docx') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/extract-results/batch/batch-1')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              extract_result: {
                file_name: 'lesson.docx',
                state: 'done',
                full_zip_url: 'https://download.example/result.zip',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://download.example/result.zip') {
        return new Response(
          zipBuffer.buffer.slice(
            zipBuffer.byteOffset,
            zipBuffer.byteOffset + zipBuffer.byteLength,
          ) as ArrayBuffer,
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseWithMinerUCloud(
      {
        providerId: 'mineru-cloud',
        apiKey: 'cloud-key',
        baseUrl: 'https://mineru.example/api/v4',
      },
      Buffer.from('docx bytes'),
      'lesson.docx',
    );

    expect(result.text).toContain('Parsed lesson');
    expect(result.metadata?.parser).toBe('mineru-cloud');
    expect(batchBodies).toEqual([
      expect.objectContaining({
        files: [{ name: 'lesson.docx' }],
      }),
    ]);
  });

  it('preserves legacy Office filenames (cloud accepts .doc/.ppt/.xls)', async () => {
    const zip = new JSZip();
    zip.file('full.md', '# Parsed legacy lesson');
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const batchBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/file-urls/batch')) {
        batchBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              batch_id: 'batch-legacy',
              file_urls: ['https://upload.example/legacy.doc'],
            },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://upload.example/legacy.doc') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/extract-results/batch/batch-legacy')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            data: {
              extract_result: {
                file_name: 'legacy.doc',
                state: 'done',
                full_zip_url: 'https://download.example/legacy.zip',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://download.example/legacy.zip') {
        return new Response(
          zipBuffer.buffer.slice(
            zipBuffer.byteOffset,
            zipBuffer.byteOffset + zipBuffer.byteLength,
          ) as ArrayBuffer,
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await parseWithMinerUCloud(
      {
        providerId: 'mineru-cloud',
        apiKey: 'cloud-key',
        baseUrl: 'https://mineru.example/api/v4',
      },
      Buffer.from('doc bytes'),
      'legacy.doc',
    );

    expect(result.text).toContain('Parsed legacy lesson');
    expect(batchBodies).toEqual([
      expect.objectContaining({
        files: [{ name: 'legacy.doc' }],
      }),
    ]);
  });
});
