import { describe, expect, it } from 'vitest';

import { uniqAlignLines, type AlignLine } from '@/lib/utils/element';

describe('uniqAlignLines', () => {
  it('dedupes by value and merges ranges to the outer bounds', () => {
    const lines: AlignLine[] = [
      { value: 10, range: [0, 5] },
      { value: 20, range: [2, 8] },
      { value: 10, range: [3, 12] },
      { value: 10, range: [-1, 4] },
    ];
    expect(uniqAlignLines(lines)).toEqual([
      { value: 10, range: [-1, 12] }, // min(0,3,-1) .. max(5,12,4)
      { value: 20, range: [2, 8] },
    ]);
  });

  it('preserves first-occurrence order', () => {
    const lines: AlignLine[] = [
      { value: 30, range: [0, 1] },
      { value: 10, range: [0, 1] },
      { value: 20, range: [0, 1] },
      { value: 10, range: [0, 1] },
    ];
    expect(uniqAlignLines(lines).map((l) => l.value)).toEqual([30, 10, 20]);
  });

  it('returns a single line unchanged', () => {
    const lines: AlignLine[] = [{ value: 7, range: [1, 2] }];
    expect(uniqAlignLines(lines)).toEqual([{ value: 7, range: [1, 2] }]);
  });

  it('returns [] for empty input', () => {
    expect(uniqAlignLines([])).toEqual([]);
  });

  it('collapses many duplicates to the unique values (linear)', () => {
    const lines: AlignLine[] = Array.from({ length: 5000 }, (_, i) => ({
      value: i % 50,
      range: [i, i + 1] as [number, number],
    }));
    expect(uniqAlignLines(lines)).toHaveLength(50);
  });
});
