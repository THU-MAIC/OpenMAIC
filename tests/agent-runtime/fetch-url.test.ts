/**
 * fetch_url engine tests — ported from the reference product's
 * tests/agent-runtime/fetch-url.test.ts.
 *
 * The strict-fetch path's security core is exercised here (private-IP literal
 * spellings, unsafe DNS answer sets, userinfo/nonstandard ports, redirect
 * revalidation), together with the bounded download, the anti-bot marker
 * check, the HTML→markdown golden case, the PDF provider chain, and abort
 * handling. The tool-level trust-gate refusal and persistence round-trip are
 * in fetch-url-tool.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { getDocumentExtractorProvider, type DocumentArtifact } from '@/lib/document';
import {
  assertSafeLookupAddresses,
  extractHtmlToMarkdown,
  fetchAndExtractUrl,
  FetchUrlError,
  normalizeUntrustedText,
} from '@/lib/server/agent-runtime/fetch-url';
import * as providerConfig from '@/lib/server/provider-config';
import { normalizeUrlForStrictFetch } from '@/lib/server/ssrf-guard';

const dispatcher = {} as never;
const chineseFixture = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/fetch-url/chinese-article.html'),
  'utf8',
);

function pdfArtifact(providerId: string, text: string): DocumentArtifact {
  return {
    metadata: { fileName: 'fetched.pdf', mimeType: 'application/pdf', providerId },
    blocks: [{ id: 'block-1', type: 'markdown', text }],
    assets: [],
  };
}

async function pdfBytes(pageCount = 1): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) pdf.addPage();
  return Buffer.from(await pdf.save());
}

afterEach(() => vi.restoreAllMocks());

describe('fetch_url network and extraction', () => {
  it.each([
    'http://127.0.0.1',
    'http://2130706433',
    'http://0177.0.0.1',
    'http://[::1]',
    'http://[::ffff:127.0.0.1]',
    'http://100.100.100.200',
    'http://[fd00:ec2::254]',
    'http://metadata.google.internal',
  ])('rejects private IP literal spelling %s before lookup', (url) => {
    expect(() => normalizeUrlForStrictFetch(url)).toThrow(/private|reserved/i);
  });

  it('rejects a DNS answer set when any resolved address is unsafe', () => {
    expect(() =>
      assertSafeLookupAddresses([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).toThrow(/private|reserved/i);
  });

  it('rejects userinfo and nonstandard ports', () => {
    expect(() => normalizeUrlForStrictFetch('https://user:pass@example.com/')).toThrow(/userinfo/i);
    expect(() => normalizeUrlForStrictFetch('https://example.com:8443/')).toThrow(
      /ports 80 and 443/i,
    );
  });

  it('revalidates redirects and rejects an internal target', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://2130706433/secret' } }),
      );
    await expect(
      fetchAndExtractUrl('https://example.com/start', { fetchImpl, dispatcher }),
    ).rejects.toThrow(/private|reserved/i);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('checks every redirect target with the supplied session trust gate before fetching it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.example/landing' },
      }),
    );
    const isUrlAllowed = vi.fn().mockResolvedValue(false);

    await expect(
      fetchAndExtractUrl('https://trusted.example/start', {
        fetchImpl,
        dispatcher,
        isUrlAllowed,
      }),
    ).rejects.toMatchObject({ reason: 'blocked' });
    expect(isUrlAllowed).toHaveBeenCalledWith('https://untrusted.example/landing');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('streams only to the byte limit and marks the material truncated', async () => {
    const body = '正文'.repeat(300);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(body, {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(body.length * 3),
        },
      }),
    );
    const result = await fetchAndExtractUrl('https://example.com/large.txt', {
      fetchImpl,
      dispatcher,
      maxBytes: 300,
      minChars: 20,
    });
    expect(result.truncated).toBe(true);
    expect(result.downloadedBytes).toBe(300);
    expect(Buffer.byteLength(result.markdown)).toBeLessThanOrEqual(300);
  });

  it('enforces an absolute body deadline against slow-drip responses', async () => {
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        stream.enqueue(new TextEncoder().encode('x'));
        await new Promise((resolve) => setTimeout(resolve, 8));
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/plain' } }));

    await expect(
      fetchAndExtractUrl('https://example.com/slow-drip', {
        fetchImpl,
        dispatcher,
        bodyTimeoutMs: 20,
        minChars: 1,
      }),
    ).rejects.toMatchObject({ reason: 'network', message: /Timed out/ });
  });

  it('fails loudly when an anti-bot marker is returned with HTTP 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`页面提示：环境异常/完成验证。${'占位'.repeat(200)}`, {
        headers: { 'content-type': 'text/plain' },
      }),
    );
    await expect(
      fetchAndExtractUrl('https://example.com/blocked', {
        fetchImpl,
        dispatcher,
        minChars: 20,
      }),
    ).rejects.toMatchObject({ reason: 'blocked' } satisfies Partial<FetchUrlError>);
  });

  it('selects configured self-hosted MinerU for PDF extraction', async () => {
    vi.spyOn(providerConfig, 'getServerPDFProviders').mockReturnValue({ mineru: {} });
    const mineru = getDocumentExtractorProvider('mineru')!;
    const unpdf = getDocumentExtractorProvider('unpdf')!;
    const mineruExtract = vi
      .spyOn(mineru, 'extract')
      .mockResolvedValue(pdfArtifact('mineru', 'MinerU 正文'.repeat(50)));
    const unpdfExtract = vi.spyOn(unpdf, 'extract');
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response((await pdfBytes()) as unknown as BodyInit, {
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const result = await fetchAndExtractUrl('https://example.com/document.pdf', {
      fetchImpl,
      dispatcher,
      minChars: 20,
    });

    expect(result.markdown).toContain('MinerU 正文');
    expect(mineruExtract).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining({ providerId: 'mineru' }) }),
    );
    expect(unpdfExtract).not.toHaveBeenCalled();
  });

  it('falls back to unpdf when no managed PDF provider is configured', async () => {
    vi.spyOn(providerConfig, 'getServerPDFProviders').mockReturnValue({});
    const unpdf = getDocumentExtractorProvider('unpdf')!;
    const unpdfExtract = vi
      .spyOn(unpdf, 'extract')
      .mockResolvedValue(pdfArtifact('unpdf', 'unpdf 正文'.repeat(50)));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response((await pdfBytes()) as unknown as BodyInit, {
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const result = await fetchAndExtractUrl('https://example.com/document.pdf', {
      fetchImpl,
      dispatcher,
      minChars: 20,
    });

    expect(result.markdown).toContain('unpdf 正文');
    expect(unpdfExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ providerId: 'unpdf', textOnly: true }),
      }),
    );
  });

  it('limits untrusted PDFs to 50 pages before extraction', async () => {
    vi.spyOn(providerConfig, 'getServerPDFProviders').mockReturnValue({});
    const input = await pdfBytes(51);
    const unpdf = getDocumentExtractorProvider('unpdf')!;
    const unpdfExtract = vi.spyOn(unpdf, 'extract').mockImplementation(async ({ buffer }) => {
      const prepared = await PDFDocument.load(buffer);
      expect(prepared.getPageCount()).toBe(50);
      return pdfArtifact('unpdf', 'bounded PDF text'.repeat(30));
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(input as unknown as BodyInit, {
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const result = await fetchAndExtractUrl('https://example.com/large.pdf', {
      fetchImpl,
      dispatcher,
      minChars: 20,
    });

    expect(result.truncated).toBe(true);
    expect(unpdfExtract).toHaveBeenCalledOnce();
  });

  it('caps extracted PDF text independently of the download size', async () => {
    vi.spyOn(providerConfig, 'getServerPDFProviders').mockReturnValue({});
    const unpdf = getDocumentExtractorProvider('unpdf')!;
    vi.spyOn(unpdf, 'extract').mockResolvedValue(pdfArtifact('unpdf', 'x'.repeat(1_200_000)));
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response((await pdfBytes()) as unknown as BodyInit, {
        headers: { 'content-type': 'application/pdf' },
      }),
    );

    const result = await fetchAndExtractUrl('https://example.com/text-bomb.pdf', {
      fetchImpl,
      dispatcher,
      minChars: 20,
    });

    expect(result.markdown).toHaveLength(1_000_000);
    expect(result.truncated).toBe(true);
  });

  it('extracts a sub-500-character Chinese article because charThreshold is 200', () => {
    const result = extractHtmlToMarkdown(chineseFixture, 'https://example.com/article');
    expect(result.markdown.length).toBeGreaterThanOrEqual(200);
    expect(result.markdown.length).toBeLessThan(500);
    expect(result.markdown).toContain('科学探究');
    expect(result.markdown).not.toMatch(/首页 导航|版权信息|隐私政策/);
  });

  it('normalizes Unicode and removes zero-width, BiDi and private-use controls', () => {
    expect(normalizeUntrustedText('Ａ\u200bB\u202eC\ue000D')).toBe('ABCD');
  });

  it('fails fast without opening a connection when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      fetchAndExtractUrl('https://example.com/page', {
        fetchImpl,
        dispatcher,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: 'network', message: 'Operation aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts the body read when the signal fires mid-download', async () => {
    const controller = new AbortController();
    let releasePull: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        stream.enqueue(new Uint8Array(1024));
        // Stall the stream until the test stops the run, so the next read is
        // in flight when the signal fires.
        await gate;
        stream.close();
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/plain' } }));
    const pending = fetchAndExtractUrl('https://example.com/slow', {
      fetchImpl,
      dispatcher,
      minChars: 1,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    releasePull?.();
    await expect(pending).rejects.toMatchObject({
      reason: 'network',
      message: 'Operation aborted',
    });
  });
});
