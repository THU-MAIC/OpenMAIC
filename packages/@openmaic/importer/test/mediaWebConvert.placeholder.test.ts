import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { isPlaceholderDataUrl } from '../src/utils/mediaWebConvert';

const TRANSPARENT_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=';
const LEGACY_RED_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface PngScanline {
  filter: number;
  rgba: number[];
}

/** Minimal PNG reader: returns the first scanline of a 1×1 RGBA PNG. */
function decodeSinglePixelPng(dataUrl: string): PngScanline {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  // PNG magic
  expect(bytes.slice(0, 8)).toEqual(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );

  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: number[] = [];
  while (pos < bytes.length) {
    const length =
      (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    const type = String.fromCharCode(
      bytes[pos + 4],
      bytes[pos + 5],
      bytes[pos + 6],
      bytes[pos + 7],
    );
    const data = bytes.slice(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(...data);
    }
    pos += 12 + length;
  }

  expect(width).toBe(1);
  expect(height).toBe(1);
  expect(colorType).toBe(6); // RGBA

  // Tests run in Node; zlib handles the IDAT stream without extra deps.
  const raw = inflateSync(Buffer.from(idat));
  return { filter: raw[0], rgba: Array.from(raw.slice(1, 5)) };
}

describe('mediaWebConvert · placeholder constant', () => {
  it('current placeholder is a 1×1 RGBA PNG with alpha 0 (fully transparent)', () => {
    const { filter, rgba } = decodeSinglePixelPng(TRANSPARENT_PLACEHOLDER);
    expect(filter).toBe(0);
    expect(rgba[3]).toBe(0);
  });

  it('legacy 0.1.4 placeholder is still 1×1 (red 50% pixel) and detected as placeholder', () => {
    const { rgba } = decodeSinglePixelPng(LEGACY_RED_PLACEHOLDER);
    expect(rgba).toEqual([255, 0, 0, 127]);
    expect(isPlaceholderDataUrl(LEGACY_RED_PLACEHOLDER)).toBe(true);
  });

  it('isPlaceholderDataUrl matches the current placeholder', () => {
    expect(isPlaceholderDataUrl(TRANSPARENT_PLACEHOLDER)).toBe(true);
  });

  it('isPlaceholderDataUrl rejects real media sources', () => {
    expect(isPlaceholderDataUrl(undefined)).toBe(false);
    expect(isPlaceholderDataUrl('')).toBe(false);
    expect(isPlaceholderDataUrl('https://cdn.example.com/shares/media/abc.png')).toBe(false);
    expect(
      isPlaceholderDataUrl(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      ),
    ).toBe(false);
  });
});
