import { describe, expect, it } from 'vitest';
import {
  EMPTY_PAGES,
  RAIL_INITIAL_ROWS,
  RAIL_PAGE_SIZE,
  nextPage,
  pageList,
  pagesFor,
  withPages,
} from '@/lib/workbench/workspace-paging';

const rows = (count: number) => Array.from({ length: count }, (_, i) => `r${i}`);

describe('pageList', () => {
  it('shows the initial window at rest', () => {
    const page = pageList(rows(139), 0);
    expect(page.visible).toHaveLength(RAIL_INITIAL_ROWS);
    expect(page.hiddenCount).toBe(139 - RAIL_INITIAL_ROWS);
    expect(page.canCollapse).toBe(false);
  });

  it('appends exactly one page per open page', () => {
    expect(pageList(rows(139), 1).visible).toHaveLength(RAIL_INITIAL_ROWS + RAIL_PAGE_SIZE);
    expect(pageList(rows(139), 2).visible).toHaveLength(RAIL_INITIAL_ROWS + 2 * RAIL_PAGE_SIZE);
    expect(pageList(rows(139), 3).visible).toHaveLength(RAIL_INITIAL_ROWS + 3 * RAIL_PAGE_SIZE);
  });

  it('promises only rows that exist', () => {
    // 139 rows: far more than a page is hidden, so a full page is promised.
    expect(pageList(rows(139), 0).nextCount).toBe(RAIL_PAGE_SIZE);
    // A short tail promises only the tail.
    expect(pageList(rows(20), 0).nextCount).toBe(20 - RAIL_INITIAL_ROWS);
    expect(pageList(rows(RAIL_INITIAL_ROWS), 0).nextCount).toBe(0);
  });

  it('never slices past the end', () => {
    const page = pageList(rows(10), 99);
    expect(page.visible).toHaveLength(10);
    expect(page.hiddenCount).toBe(0);
    expect(page.nextCount).toBe(0);
  });

  it('offers 收起 only once a page is actually open', () => {
    expect(pageList(rows(139), 0).canCollapse).toBe(false);
    expect(pageList(rows(139), 1).canCollapse).toBe(true);
    // A short list can never have opened a page, whatever the count says.
    expect(pageList(rows(3), 4).canCollapse).toBe(false);
  });

  it('returns the input reference when nothing is hidden', () => {
    const list = rows(4);
    expect(pageList(list, 0).visible).toBe(list);
  });

  it('clamps hostile page counts to the resting state', () => {
    for (const bad of [-1, -99, Number.NaN, Number.POSITIVE_INFINITY * -1]) {
      expect(pageList(rows(50), bad).visible).toHaveLength(RAIL_INITIAL_ROWS);
    }
    // Fractional pages floor rather than producing a fractional slice.
    expect(pageList(rows(50), 1.9).visible).toHaveLength(RAIL_INITIAL_ROWS + RAIL_PAGE_SIZE);
  });

  it('honours an overridden window', () => {
    const page = pageList(rows(30), 1, { initial: 3, pageSize: 5 });
    expect(page.visible).toHaveLength(8);
    expect(page.nextCount).toBe(5);
  });

  it('treats a zero page size as one row rather than dividing by nothing', () => {
    const page = pageList(rows(10), 2, { initial: 1, pageSize: 0 });
    expect(page.visible).toHaveLength(3);
  });
});

describe('nextPage', () => {
  it('counts up one page at a time', () => {
    expect(nextPage(rows(139), 0)).toBe(1);
    expect(nextPage(rows(139), 1)).toBe(2);
  });

  it('stops at the page that shows the last row', () => {
    const pages = Math.ceil((139 - RAIL_INITIAL_ROWS) / RAIL_PAGE_SIZE);
    expect(nextPage(rows(139), pages - 1)).toBe(pages);
    expect(nextPage(rows(139), pages)).toBe(pages);
    expect(nextPage(rows(139), 99)).toBe(pages);
  });

  it('cannot inflate a count on a list that is already whole', () => {
    // Pressing on a short list must not bank pages that a later, longer list
    // would then cash in.
    expect(nextPage(rows(RAIL_INITIAL_ROWS), 0)).toBe(0);
    expect(nextPage(rows(RAIL_INITIAL_ROWS), 3)).toBe(0);
  });
});

describe('page map', () => {
  it('reads absent lists as resting', () => {
    expect(pagesFor(EMPTY_PAGES, 'unfiled')).toBe(0);
  });

  it('returns the same map when the value would not change', () => {
    const map = withPages(EMPTY_PAGES, 'unfiled', 2);
    expect(withPages(map, 'unfiled', 2)).toBe(map);
    expect(withPages(EMPTY_PAGES, 'unfiled', 0)).toBe(EMPTY_PAGES);
  });

  it('drops the entry rather than storing a resting zero', () => {
    const map = withPages(withPages(EMPTY_PAGES, 'unfiled', 2), 'unfiled', 0);
    expect(map.has('unfiled')).toBe(false);
  });

  it('keeps lists independent', () => {
    const map = withPages(withPages(EMPTY_PAGES, 'unfiled', 2), 'saved', 1);
    expect(pagesFor(map, 'unfiled')).toBe(2);
    expect(pagesFor(map, 'saved')).toBe(1);
  });
});
