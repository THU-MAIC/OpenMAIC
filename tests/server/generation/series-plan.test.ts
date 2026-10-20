import { describe, expect, it } from 'vitest';

import type { ParsedDocumentPart } from '@/lib/document/bundle';
import { planCourseSeries } from '@/lib/server/generation/series/plan';

function part(order: number, id: string, text: string): ParsedDocumentPart {
  return {
    source: { id, name: `${id}.pdf`, size: 1024, mimeType: 'application/pdf', order },
    text,
    rawTextLength: text.length,
    images: [],
  };
}

describe('planCourseSeries', () => {
  it('returns null under the budget', () => {
    expect(planCourseSeries([part(1, 'doc-1', 'a'.repeat(50))], 100)).toBeNull();
  });

  it('gives each part the whole range of a material it owns entirely', () => {
    const parts = [part(1, 'doc-1', 'a'.repeat(60)), part(2, 'doc-2', 'b'.repeat(60))];
    const plan = planCourseSeries(parts, 100);
    expect(plan).not.toBeNull();
    expect(plan).toEqual([
      { order: 1, textRanges: { 'doc-1': { start: 0, end: 60 } } },
      { order: 2, textRanges: { 'doc-2': { start: 0, end: 60 } } },
    ]);
  });

  it('gives consecutive, non-overlapping ranges across a material split over several parts', () => {
    const plan = planCourseSeries([part(1, 'doc-1', 'word '.repeat(60))], 50);
    expect(plan).not.toBeNull();
    const ranges = plan!.map((p) => p.textRanges['doc-1']!);
    // Every range is non-empty, consecutive, and together cover the whole text.
    expect(ranges[0]!.start).toBe(0);
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!.start).toBe(ranges[i - 1]!.end);
    }
    const totalText = 'word '.repeat(60);
    expect(ranges.at(-1)!.end).toBe(totalText.length);
    for (const range of ranges) expect(range.end).toBeGreaterThan(range.start);
  });

  it('reconstructs the exact slices sliceDocumentPart produced, via the ranges', () => {
    const text = 'word '.repeat(60);
    const plan = planCourseSeries([part(1, 'doc-1', text)], 50);
    expect(plan).not.toBeNull();
    const reassembled = plan!.map((p) => {
      const range = p.textRanges['doc-1']!;
      return text.slice(range.start, range.end);
    });
    expect(reassembled.join('')).toBe(text);
  });

  it('keeps each part to only the materials it actually teaches', () => {
    const parts = [part(1, 'doc-1', 'a'.repeat(80)), part(2, 'doc-2', 'b'.repeat(80))];
    const plan = planCourseSeries(parts, 100);
    expect(plan).not.toBeNull();
    // doc-1 alone is 80 chars (fits in one 100-char part); doc-2 starts a new part.
    expect(Object.keys(plan![0]!.textRanges)).toEqual(['doc-1']);
    expect(Object.keys(plan![1]!.textRanges)).toEqual(['doc-2']);
  });
});
