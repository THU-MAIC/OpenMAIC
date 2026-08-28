import { describe, expect, it } from 'vitest';
import {
  applyCustomOrder,
  edgeFor,
  parseOrder,
  pruneOrder,
  reorderIds,
  serializeOrder,
} from '@/lib/workbench/workspace-order';

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);
const items = (...list: string[]) => list.map((id) => ({ id }));

describe('applyCustomOrder', () => {
  it('sorts by the stored order', () => {
    expect(ids(applyCustomOrder(items('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('returns the original reference when there is no stored order', () => {
    const list = items('a', 'b');
    expect(applyCustomOrder(list, [])).toBe(list);
  });

  it('returns the original reference when the stored order is entirely stale', () => {
    const list = items('a', 'b');
    expect(applyCustomOrder(list, ['gone', 'also-gone'])).toBe(list);
  });

  it('puts items the order has never seen at the TOP, in arrival order', () => {
    // The incoming list is newest-first, so a course created after the last
    // drag must land where the user will look for it.
    expect(ids(applyCustomOrder(items('new2', 'new1', 'b', 'a'), ['a', 'b']))).toEqual([
      'new2',
      'new1',
      'a',
      'b',
    ]);
  });

  it('ignores ids the live list no longer has', () => {
    expect(ids(applyCustomOrder(items('a', 'c'), ['c', 'deleted', 'a']))).toEqual(['c', 'a']);
  });

  it('is stable across duplicate ids in a corrupt stored order', () => {
    expect(ids(applyCustomOrder(items('a', 'b'), ['b', 'b', 'a', 'b']))).toEqual(['b', 'a']);
  });
});

describe('reorderIds', () => {
  it('moves an item before a neighbour', () => {
    expect(reorderIds(['a', 'b', 'c'], 'c', { before: 'a' })).toEqual(['c', 'a', 'b']);
  });

  it('moves an item after a neighbour', () => {
    expect(reorderIds(['a', 'b', 'c'], 'a', { after: 'c' })).toEqual(['b', 'c', 'a']);
  });

  it('handles a downward move without an off-by-one', () => {
    // The anchor index has to be taken AFTER the dragged id is removed.
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', { before: 'c' })).toEqual(['b', 'a', 'c', 'd']);
    expect(reorderIds(['a', 'b', 'c', 'd'], 'a', { after: 'b' })).toEqual(['b', 'a', 'c', 'd']);
  });

  it('leaves the sequence alone when the drop lands where it started', () => {
    const start = ['a', 'b', 'c'];
    expect(reorderIds(start, 'b', { after: 'a' })).toBe(start);
    expect(reorderIds(start, 'b', { before: 'c' })).toBe(start);
  });

  it('is a no-op when dropped onto itself', () => {
    const start = ['a', 'b', 'c'];
    expect(reorderIds(start, 'b', { before: 'b' })).toBe(start);
  });

  it('is a no-op when either id is unknown', () => {
    const start = ['a', 'b'];
    expect(reorderIds(start, 'ghost', { before: 'a' })).toBe(start);
    expect(reorderIds(start, 'a', { before: 'ghost' })).toBe(start);
  });

  it('keeps ids outside the dragged row untouched, so one folder cannot disturb another', () => {
    // Flat sequence: folder-1 members, then folder-2 members.
    const flat = ['f1a', 'f1b', 'f1c', 'f2a', 'f2b'];
    expect(reorderIds(flat, 'f1c', { before: 'f1a' })).toEqual(['f1c', 'f1a', 'f1b', 'f2a', 'f2b']);
  });
});

describe('pruneOrder', () => {
  it('drops ids the live list no longer has', () => {
    expect(pruneOrder(['a', 'gone', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('collapses duplicates', () => {
    expect(pruneOrder(['a', 'a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns the original reference when nothing changes', () => {
    const order = ['a', 'b'];
    expect(pruneOrder(order, ['a', 'b', 'c'])).toBe(order);
  });
});

describe('parseOrder', () => {
  it('reads a serialized order back', () => {
    expect(parseOrder(serializeOrder(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('degrades to no order on null, garbage, or the wrong shape', () => {
    expect(parseOrder(null)).toEqual([]);
    expect(parseOrder('not json')).toEqual([]);
    expect(parseOrder('{"a":1}')).toEqual([]);
    expect(parseOrder('[]')).toEqual([]);
  });

  it('keeps only non-empty strings and de-duplicates them', () => {
    expect(parseOrder('["a", 1, null, "", "a", "b"]')).toEqual(['a', 'b']);
  });
});

describe('edgeFor', () => {
  it('splits a row at its midpoint, with no dead band', () => {
    const rect = { top: 100, height: 34 };
    expect(edgeFor(100, rect)).toBe('before');
    expect(edgeFor(116, rect)).toBe('before');
    expect(edgeFor(117, rect)).toBe('after');
    expect(edgeFor(133, rect)).toBe('after');
  });
});
