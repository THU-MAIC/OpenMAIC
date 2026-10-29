/**
 * The stored result of an extraction whose images were links stays within the
 * result limit: the download budget is what the text and metadata leave, and
 * downloaded images are dropped from the end while the result is still over.
 */
import { describe, expect, it } from 'vitest';

import {
  fitDownloadedImages,
  remoteImageByteBudget,
  type MaterialExtractionResult,
} from '@/lib/server/materials/extraction';

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const image = (id: string, src: string) => ({ id, src, pageNumber: 1 });

describe('remoteImageByteBudget', () => {
  it('is 3/4 of what the text, metadata and per-image overhead leave', () => {
    const empty: MaterialExtractionResult = { version: 1, text: '', images: [] };
    const linked = (text: string): MaterialExtractionResult => ({
      version: 1,
      text,
      images: [image('img_1', 'https://a/1'), image('img_2', 'https://a/2')],
    });
    const max = 1_000_000;

    const short = remoteImageByteBudget(linked(''), max);
    const long = remoteImageByteBudget(linked('t'.repeat(400_000)), max);

    expect(short).toBeLessThan(Math.floor((max - bytes(empty)) * 0.75));
    // Every byte of text takes 3/4 of a byte of image budget away.
    expect(short - long).toBe(300_000);
    expect(remoteImageByteBudget(linked('t'.repeat(max)), max)).toBe(0);
  });

  it('counts an inline image against the room, in full', () => {
    const inline = `data:image/png;base64,${'A'.repeat(40_000)}`;
    const withInline: MaterialExtractionResult = {
      version: 1,
      text: '',
      images: [image('img_1', inline), image('img_2', 'https://a/2')],
    };
    const without: MaterialExtractionResult = {
      version: 1,
      text: '',
      images: [image('img_1', ''), image('img_2', 'https://a/2')],
    };
    // Its whole data URL (prefix included), at 3/4, give or take rounding.
    const taken =
      remoteImageByteBudget(without, 1_000_000) - remoteImageByteBudget(withInline, 1_000_000);
    expect(Math.abs(taken - inline.length * 0.75)).toBeLessThanOrEqual(1);
  });
});

describe('fitDownloadedImages', () => {
  const payload = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;

  it('drops downloaded images from the end until the result fits', () => {
    const extractorInline = image('img_1', payload(1000));
    const downloaded = [2, 3, 4].map((n) => image(`img_${n}`, payload(1000)));
    const result: MaterialExtractionResult = {
      version: 1,
      text: 'body',
      images: [extractorInline, ...downloaded],
    };
    const max = bytes(result) - 500;

    const fitted = fitDownloadedImages(result, new Set(downloaded), max);

    expect(fitted.dropped).toBe(1);
    expect(fitted.result.images.map((entry) => entry.id)).toEqual(['img_1', 'img_2', 'img_3']);
    expect(bytes(fitted.result)).toBeLessThanOrEqual(max);
  });

  it('is exact at the limit and never drops an image the extractor answered inline', () => {
    const only = image('img_1', payload(1000));
    const downloaded = image('img_2', payload(1000));
    const result: MaterialExtractionResult = { version: 1, text: '', images: [only, downloaded] };

    expect(fitDownloadedImages(result, new Set([downloaded]), bytes(result))).toEqual({
      result,
      dropped: 0,
    });
    const over = fitDownloadedImages(result, new Set([downloaded]), 10);
    expect(over.dropped).toBe(1);
    expect(over.result.images).toEqual([only]);
  });
});
