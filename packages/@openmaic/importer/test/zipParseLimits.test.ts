import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ZIP_PARSE_LIMITS, parseZip } from '../src/parser/ZipParser';

/**
 * A zip whose single entry is mostly repetition, so it inflates far past what
 * it occupies on disk. DEFLATE tops out around 1032:1, so this is well over the
 * default ratio limit without being contrived.
 */
async function compressedBomb(path: string, uncompressedBytes: number): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(path, new Uint8Array(uncompressedBytes));
  // DEFLATE explicitly: generateAsync defaults to STORE, which stores the
  // bytes verbatim and publishes no compressed size on the entry at all.
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

async function archive(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('parseZip limits', () => {
  it('rejects a highly compressed entry without the caller passing any limits', async () => {
    // The regression this guards: every limit used to be optional and no caller
    // passed one, so a call with no arguments ran with all bounds disabled.
    const buffer = await compressedBomb('ppt/media/zeros.bin', 1024 * 1024);
    await expect(parseZip(buffer)).rejects.toThrow(/maxCompressionRatio/);
  });

  it('lets a caller switch a single bound off with Infinity', async () => {
    const buffer = await compressedBomb('ppt/media/zeros.bin', 1024 * 1024);
    const files = await parseZip(buffer, { maxCompressionRatio: Number.POSITIVE_INFINITY });
    expect(files.media.get('ppt/media/zeros.bin')?.byteLength).toBe(1024 * 1024);
  });

  it('keeps the other bounds at their defaults when one is overridden', async () => {
    // The per-field defaulting is the point of the change: a caller who sets one
    // bound must not thereby switch the rest off.
    const buffer = await compressedBomb('ppt/media/zeros.bin', 1024 * 1024);
    await expect(parseZip(buffer, { maxEntries: 100 })).rejects.toThrow(/maxCompressionRatio/);
  });

  it('treats an empty limits object exactly like no argument', async () => {
    const buffer = await compressedBomb('ppt/media/zeros.bin', 1024 * 1024);
    await expect(parseZip(buffer, {})).rejects.toThrow(/maxCompressionRatio/);
  });

  it('refuses a limit that is neither finite nor Infinity', async () => {
    // Number(process.env.MAX_ENTRIES) on an unset variable is NaN, and NaN
    // compares false against every bound — which would disable it silently.
    const buffer = await archive({ 'ppt/presentation.xml': '<p:presentation/>' });
    await expect(parseZip(buffer, { maxEntries: Number.NaN })).rejects.toThrow(/maxEntries NaN/);
  });

  it('parses an ordinary archive under the default limits', async () => {
    const buffer = await archive({
      'ppt/presentation.xml': '<p:presentation/>',
      'ppt/media/pixel.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
      'ppt/slides/slide1.xml': '<p:sld/>',
    });

    const files = await parseZip(buffer);
    expect(files.presentation).toBe('<p:presentation/>');
    expect(files.slides.get('ppt/slides/slide1.xml')).toBe('<p:sld/>');
    expect(files.media.size).toBe(1);
  });

  it('parses the shipped regression deck under the defaults', async () => {
    // The one real .pptx in this repo, so the defaults get exercised against a
    // deck someone actually built rather than only against fixtures we shaped.
    // Measured on this file: 21 entries, 53,889 bytes uncompressed, and a
    // worst-case entry ratio of 9.1:1 — three orders of magnitude inside the
    // 10,000 / 2 GiB / 200:1 defaults.
    const deck = new Uint8Array(
      readFileSync(resolve(__dirname, 'fixtures/rendering-regression-demo.pptx')),
    );
    const files = await parseZip(deck.buffer as ArrayBuffer);
    expect(files.slides.size).toBeGreaterThan(0);
    expect(files.presentation.length).toBeGreaterThan(0);
  });

  it('rejects an archive with more entries than maxEntries', async () => {
    const buffer = await archive({ a: 'a', b: 'b', c: 'c' });
    await expect(
      parseZip(buffer, { maxEntries: 2, maxCompressionRatio: Infinity }),
    ).rejects.toThrow(/maxEntries 2/);
  });

  it('rejects an entry larger than maxEntryUncompressedBytes', async () => {
    const buffer = await archive({ 'ppt/slides/slide1.xml': 'x'.repeat(4096) });
    await expect(
      parseZip(buffer, { maxEntryUncompressedBytes: 1024, maxCompressionRatio: Infinity }),
    ).rejects.toThrow(/maxEntryUncompressedBytes 1024/);
  });

  it('rejects an archive whose entries sum past maxTotalUncompressedBytes', async () => {
    const buffer = await archive({
      'ppt/slides/slide1.xml': 'x'.repeat(2048),
      'ppt/slides/slide2.xml': 'y'.repeat(2048),
    });
    // Each entry is under the per-entry bound; only the running total trips.
    await expect(
      parseZip(buffer, { maxTotalUncompressedBytes: 3072, maxCompressionRatio: Infinity }),
    ).rejects.toThrow(/maxTotalUncompressedBytes 3072/);
  });

  it('rejects media past maxMediaBytes while leaving non-media entries alone', async () => {
    const buffer = await archive({
      'ppt/slides/slide1.xml': 'x'.repeat(4096),
      'ppt/media/a.bin': new Uint8Array(2048),
    });
    await expect(
      parseZip(buffer, {
        maxMediaBytes: 1024,
        maxEntryUncompressedBytes: 8192,
        maxCompressionRatio: Infinity,
      }),
    ).rejects.toThrow(/maxMediaBytes 1024/);
  });

  it('keeps validating maxConcurrency', async () => {
    const buffer = await archive({ 'ppt/presentation.xml': '<p:presentation/>' });
    await expect(parseZip(buffer, { maxConcurrency: 0 })).rejects.toThrow(/maxConcurrency/);
  });

  it('ships defaults that are finite and positive', () => {
    for (const [name, value] of Object.entries(DEFAULT_ZIP_PARSE_LIMITS)) {
      expect(Number.isFinite(value), `${name} should be finite`).toBe(true);
      expect(value, `${name} should be positive`).toBeGreaterThan(0);
    }
  });
});
