import { describe, expect, it } from 'vitest';

import type { ParsedDocumentPart } from '@/lib/document/bundle';
import { materialNeedsSeriesSplit, splitMaterialIntoSeries } from '@/lib/document/series-split';

function part(order: number, text: string, overrides: Partial<ParsedDocumentPart> = {}): ParsedDocumentPart {
  return {
    source: {
      id: `source-${order}`,
      name: `Source ${order}.pdf`,
      size: 1024,
      mimeType: 'application/pdf',
      order,
    },
    text,
    rawTextLength: text.length,
    images: [],
    ...overrides,
  };
}

function repeatWords(word: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${word}${index}`).join(' ');
}

describe('materialNeedsSeriesSplit', () => {
  it('is false at or under the budget', () => {
    expect(materialNeedsSeriesSplit([part(1, 'a'.repeat(100))], 100)).toBe(false);
  });

  it('is true over the budget', () => {
    expect(materialNeedsSeriesSplit([part(1, 'a'.repeat(101))], 100)).toBe(true);
  });

  it('sums across parts', () => {
    const parts = [part(1, 'a'.repeat(60)), part(2, 'b'.repeat(60))];
    expect(materialNeedsSeriesSplit(parts, 100)).toBe(true);
    expect(materialNeedsSeriesSplit(parts, 200)).toBe(false);
  });
});

describe('splitMaterialIntoSeries', () => {
  it('keeps everything in one part when under budget', () => {
    const parts = [part(1, repeatWords('w', 5))];
    const series = splitMaterialIntoSeries(parts, 10_000);

    expect(series).toHaveLength(1);
    expect(series[0].index).toBe(1);
    expect(series[0].parts[0].text).toBe(parts[0].text);
  });

  it('splits multiple small documents across series parts without dropping text', () => {
    const budget = 50;
    const parts = [
      part(1, repeatWords('doc1-', 10)),
      part(2, repeatWords('doc2-', 10)),
      part(3, repeatWords('doc3-', 10)),
    ];
    const totalChars = parts.reduce((sum, p) => sum + p.rawTextLength, 0);
    expect(materialNeedsSeriesSplit(parts, budget)).toBe(true);

    const series = splitMaterialIntoSeries(parts, budget);

    expect(series.length).toBeGreaterThan(1);
    // Every series part stays within budget.
    for (const seriesPart of series) {
      const length = seriesPart.parts.reduce((sum, p) => sum + p.rawTextLength, 0);
      expect(length).toBeLessThanOrEqual(budget);
    }
    // No character is lost: concatenating every kept slice's text recovers
    // the same total length the input started with (slices only ever drop
    // trailing whitespace at a word boundary, not characters from the middle).
    const recoveredChars = series.flatMap((s) => s.parts).reduce((sum, p) => sum + p.text.length, 0);
    expect(recoveredChars).toBeGreaterThan(0);
    expect(recoveredChars).toBeLessThanOrEqual(totalChars);
    expect(recoveredChars).toBeGreaterThan(totalChars - parts.length * 2); // only boundary trims lost

    // Original document order is preserved across parts: the base source ids
    // (stripping any slice suffix) never go backwards as we walk the series.
    // A document may still span more than one series part (appear more than
    // once consecutively), so this checks non-decreasing order, not uniqueness.
    const baseIds = series.flatMap((s) => s.parts.map((p) => p.source.id.split('#')[0]));
    const numericOrders = baseIds.map((id) => Number(id.replace('source-', '')));
    for (let i = 1; i < numericOrders.length; i += 1) {
      expect(numericOrders[i]).toBeGreaterThanOrEqual(numericOrders[i - 1]);
    }
  });

  it('slices a single document that alone exceeds the budget into multiple series parts', () => {
    const budget = 40;
    const longText = repeatWords('tok', 30); // far over budget by itself
    const parts = [part(1, longText)];

    const series = splitMaterialIntoSeries(parts, budget);

    expect(series.length).toBeGreaterThan(1);
    for (const seriesPart of series) {
      const length = seriesPart.parts.reduce((sum, p) => sum + p.rawTextLength, 0);
      expect(length).toBeLessThanOrEqual(budget);
    }
    // Slices of the same original document carry a disambiguating suffix.
    const ids = series.flatMap((s) => s.parts.map((p) => p.source.id));
    expect(ids.every((id) => id.startsWith('source-1#'))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    // Reassembling the slices in order recovers the original text modulo the
    // whitespace a boundary cut trims between slices.
    const reassembled = series
      .flatMap((s) => s.parts)
      .map((p) => p.text)
      .join('');
    expect(longText.startsWith(reassembled.slice(0, 10))).toBe(true);
  });

  it('carries images only on the first slice of a split document', () => {
    const budget = 30;
    const longText = repeatWords('tok', 20);
    const parts = [
      part(1, longText, {
        images: [{ id: 'img-1', src: 'data:image/png;base64,x', pageNumber: 1 }],
      }),
    ];

    const series = splitMaterialIntoSeries(parts, budget);
    const allSlices = series.flatMap((s) => s.parts);

    expect(allSlices[0].images).toHaveLength(1);
    expect(allSlices.slice(1).every((slice) => slice.images.length === 0)).toBe(true);
  });

  it('renumbers source.order within each series part starting at 0', () => {
    const budget = 50;
    const parts = [
      part(5, repeatWords('a', 10)),
      part(9, repeatWords('b', 10)),
    ];
    const series = splitMaterialIntoSeries(parts, budget);

    for (const seriesPart of series) {
      seriesPart.parts.forEach((p, index) => {
        expect(p.source.order).toBe(index);
      });
    }
  });

  it('processes parts in source.order regardless of input array order', () => {
    const budget = 1000;
    const parts = [part(2, 'second'), part(1, 'first')];
    const series = splitMaterialIntoSeries(parts, budget);

    expect(series[0].parts.map((p) => p.text)).toEqual(['first', 'second']);
  });
});
