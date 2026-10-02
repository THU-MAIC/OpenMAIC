import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ZIP_PARSE_LIMITS, parseZip } from '../src/parser/ZipParser';

/** Build a zip holding `files`. DEFLATE explicitly: generateAsync defaults to
 * STORE, which stores the bytes verbatim and publishes no compressed size on
 * the entry at all, so none of the bounds below would be exercised. */
async function archive(files: Record<string, string | Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

/** A slide part of one repeated character — DEFLATE's best case. */
function repetitiveTextPart(count: number): string {
  return ' '.repeat(count);
}

const solidColourBmpBytes = (width: number, height: number): number => 54 + width * height * 3;

/**
 * A 24-bit BMP of a single colour. This is the shape of ordinary deck content —
 * a diagram or a pasted screenshot on a flat background — where the pixel data
 * is constant, so DEFLATE takes it to the top of its range. Legitimate, and
 * indistinguishable by compression ratio from a bomb.
 */
function solidColourBmp(width: number, height: number): Uint8Array {
  const out = new Uint8Array(solidColourBmpBytes(width, height));
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d; // "BM"
  view.setUint32(2, out.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(28, 24, true);
  out.fill(0xff, 54);
  return out;
}

/** A 44-byte WAV header followed by constant samples, i.e. a silent track. */
function silentWav(sampleFrames: number): Uint8Array {
  const dataBytes = sampleFrames * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, out.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, 44100, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return out;
}

describe('parseZip limits', () => {
  it('rejects a highly compressed text part without the caller passing any limits', async () => {
    // The regression this guards: every limit used to be optional and no caller
    // passed one, so a call with no arguments ran with all bounds disabled.
    const buffer = await archive({ 'ppt/slides/slide1.xml': repetitiveTextPart(1 << 20) });
    await expect(parseZip(buffer)).rejects.toThrow(/maxCompressionRatio/);
  });

  it('accepts an uncompressed bitmap under the default ratio', async () => {
    // A solid-colour 24-bit BMP measures around 1000:1, so a fixed ratio below
    // DEFLATE's ceiling rejects real decks. Binary parts are exempt from it.
    const buffer = await archive({ 'ppt/media/flat.bmp': solidColourBmp(1920, 1080) });
    const files = await parseZip(buffer);
    expect(files.media.get('ppt/media/flat.bmp')?.byteLength).toBe(solidColourBmpBytes(1920, 1080));
  });

  it('accepts a silent PCM track under the default ratio', async () => {
    const buffer = await archive({ 'ppt/media/silence.wav': silentWav(44100 * 30) });
    const files = await parseZip(buffer);
    expect(files.media.size).toBe(1);
  });

  it('accepts a high-ratio embedded object under the default ratio', async () => {
    const buffer = await archive({ 'ppt/embeddings/oleObject1.bin': new Uint8Array(1 << 20) });
    const files = await parseZip(buffer);
    expect(files.embeddings.size).toBe(1);
  });

  it('still rejects the low-entropy payload when it is a text part', async () => {
    // The exemption is about the part, not about the bytes.
    const buffer = await archive({ 'ppt/slides/slide1.xml': repetitiveTextPart(1 << 20) });
    await expect(parseZip(buffer)).rejects.toThrow(/maxCompressionRatio/);
  });

  it('still rejects a text part holding a long run of empty paragraphs', async () => {
    // The realistic text-part case: 20,000 empty <a:p/> elements measure around
    // 300:1. Keep the check here and binary parts stay the only exemption.
    const buffer = await archive({ 'ppt/slides/slide1.xml': '<a:p/>'.repeat(20_000) });
    await expect(parseZip(buffer)).rejects.toThrow(/maxCompressionRatio/);
  });

  it('lets a caller switch a single bound off with Infinity', async () => {
    const buffer = await archive({ 'ppt/slides/slide1.xml': repetitiveTextPart(1 << 20) });
    const files = await parseZip(buffer, { maxCompressionRatio: Number.POSITIVE_INFINITY });
    expect(files.slides.get('ppt/slides/slide1.xml')?.length).toBe(1 << 20);
  });

  it('keeps the other bounds at their defaults when one is overridden', async () => {
    // The per-field defaulting is the point of the change: a caller who sets one
    // bound must not thereby switch the rest off.
    const buffer = await archive({ 'ppt/slides/slide1.xml': repetitiveTextPart(1 << 20) });
    await expect(parseZip(buffer, { maxEntries: 100 })).rejects.toThrow(/maxCompressionRatio/);
  });

  it('treats an empty limits object exactly like no argument', async () => {
    const buffer = await archive({ 'ppt/slides/slide1.xml': repetitiveTextPart(1 << 20) });
    await expect(parseZip(buffer, {})).rejects.toThrow(/maxCompressionRatio/);
  });

  it('refuses a limit that is neither finite nor Infinity', async () => {
    // Number(process.env.MAX_ENTRIES) on an unset variable is NaN, and NaN
    // compares false against every bound — which would disable it silently.
    const buffer = await archive({ 'ppt/presentation.xml': '<p:presentation/>' });
    await expect(parseZip(buffer, { maxEntries: Number.NaN })).rejects.toThrow(/maxEntries NaN/);
  });

  it('rejects an archive with more entries than maxEntries', async () => {
    const buffer = await archive({ a: 'a', b: 'b', c: 'c' });
    await expect(
      parseZip(buffer, { maxEntries: 2, maxCompressionRatio: Infinity }),
    ).rejects.toThrow(/maxEntries 2/);
  });

  it('rejects a maxEntries that is not a whole number', async () => {
    const buffer = await archive({ a: 'a', b: 'b', c: 'c' });
    await expect(
      parseZip(buffer, { maxEntries: 1.5, maxCompressionRatio: Infinity }),
    ).rejects.toThrow(/maxEntries 1.5/);
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
    // The absolute caps are what bound binary parts, since the ratio is exempt
    // there. This is the bound that catches an oversized image in a deck.
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

  it('ships defaults that are finite and positive', () => {
    for (const [name, value] of Object.entries(DEFAULT_ZIP_PARSE_LIMITS)) {
      expect(Number.isFinite(value), `${name} should be finite`).toBe(true);
      expect(value, `${name} should be positive`).toBeGreaterThan(0);
    }
  });
});
