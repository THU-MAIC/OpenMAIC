/**
 * How a long list in the workspace rail reveals itself.
 *
 * The rail used to cap a list in two states: seven rows, or all of them. That
 * is fine for a folder holding nine courses and wrong for the real account,
 * where "show more" read "show more (124)" and one click dropped 124 rows into a
 * 240px rail — a control whose only outcome is to destroy the list it belongs
 * to. This module replaces that cap (`truncateList`, now gone).
 *
 * So revealing is paged instead: each press appends one fixed page, the label
 * promises exactly what the press will do, and one press of collapse returns the
 * list to its first page. The state a caller has to keep is a single integer
 * per list — how many extra pages are open — which survives the list changing
 * underneath it (search, a new course, a drag) because everything here clamps.
 *
 * Pure, so the arithmetic is tested without a rail.
 */

/**
 * Rows visible before any page is appended.
 *
 * Ten, and the history of this number is the history of the rail's shape. The
 * old two-state cap showed seven before an all-or-nothing dump. v10 cut it to
 * five, not because five is a good glimpse but because three section heads —
 * conversations, courses and saved courses — had to fit on screen at once, and a boundary you scroll to
 * find is a boundary you do not have.
 *
 * v13 retires that compromise: conversations and courses are tabs over one body and saved courses is
 * a drawer at the foot, so there is exactly ONE list on screen and it owns the
 * rail's height. Ten course rows at 44px is ~440px — a real window on a 900px
 * screen with the drawer closed, and still one press from more, which is the
 * only property `pageList` actually depends on.
 */
export const RAIL_INITIAL_ROWS = 10;

/** Rows appended per press of "show more". */
export const RAIL_PAGE_SIZE = 20;

export interface PagedList<T> {
  /** The rows to render, in the input's own order. */
  readonly visible: readonly T[];
  /** Rows still folded away. 0 means the list is fully shown. */
  readonly hiddenCount: number;
  /**
   * How many rows the NEXT press would add — the number the button says. It is
   * the page size until the tail is shorter than a page, so the label never
   * promises rows that do not exist.
   */
  readonly nextCount: number;
  /** Whether a collapse control belongs beside it: only once a page is open. */
  readonly canCollapse: boolean;
}

export interface PageOptions {
  /** Rows shown at rest. Defaults to {@link RAIL_INITIAL_ROWS}. */
  readonly initial?: number;
  /** Rows added per page. Defaults to {@link RAIL_PAGE_SIZE}. */
  readonly pageSize?: number;
}

/**
 * Slice `items` for a list that has `pages` extra pages open.
 *
 * `pages` is untrusted the same way a stored order is: it outlives the list it
 * describes (search narrows the list under it, a course is deleted), so it is
 * clamped rather than trusted. Negative and fractional values degrade to the
 * resting state instead of throwing.
 *
 * The whole array is returned by reference when nothing is hidden, so a caller
 * memoising on identity does not re-render for a no-op slice.
 */
export function pageList<T>(
  items: readonly T[],
  pages: number,
  options: PageOptions = {},
): PagedList<T> {
  const initial = atLeastZero(options.initial ?? RAIL_INITIAL_ROWS);
  const pageSize = Math.max(1, atLeastZero(options.pageSize ?? RAIL_PAGE_SIZE));
  const openPages = atLeastZero(pages);

  const shown = Math.min(items.length, initial + openPages * pageSize);
  const hiddenCount = items.length - shown;

  return {
    visible: hiddenCount === 0 ? items : items.slice(0, shown),
    hiddenCount,
    nextCount: Math.min(pageSize, hiddenCount),
    // A press that revealed nothing (the list was already short) must not leave
    // a collapse control behind that would appear to do something.
    canCollapse: openPages > 0 && shown > initial,
  };
}

/**
 * The page count after a press of "show more".
 *
 * Bounded by the list length, so repeatedly pressing a list that is already
 * fully shown cannot inflate a number that a later search would then cash in.
 */
export function nextPage<T>(items: readonly T[], pages: number, options: PageOptions = {}): number {
  const initial = atLeastZero(options.initial ?? RAIL_INITIAL_ROWS);
  const pageSize = Math.max(1, atLeastZero(options.pageSize ?? RAIL_PAGE_SIZE));
  const needed = Math.ceil(Math.max(0, items.length - initial) / pageSize);
  return Math.min(needed, atLeastZero(pages) + 1);
}

/** Per-list page counts. Absent means "at rest", so an empty map is the reset. */
export type PageMap = ReadonlyMap<string, number>;

export const EMPTY_PAGES: PageMap = new Map<string, number>();

export function pagesFor(pages: PageMap, id: string): number {
  return pages.get(id) ?? 0;
}

/** Returns the SAME map when the value would not change. */
export function withPages(pages: PageMap, id: string, value: number): PageMap {
  const next = atLeastZero(value);
  if (pagesFor(pages, id) === next) return pages;
  const copy = new Map(pages);
  if (next === 0) copy.delete(id);
  else copy.set(id, next);
  return copy;
}

function atLeastZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
