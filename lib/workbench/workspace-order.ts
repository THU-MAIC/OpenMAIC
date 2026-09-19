/**
 * Manual ordering for the workspace navigation tree.
 *
 * Courses and agent sessions are both drag-reorderable in the rail. Neither has
 * a server-side order field — `live_folders.order` orders the FOLDERS, not the
 * courses inside them, and the agent session list has no order column at all —
 * so a custom order is a per-browser view preference, persisted in
 * `localStorage` beside the rail's width and the panes' collapse flags. It is
 * NOT synced across devices and NOT partitioned per account, exactly like those
 * neighbours; a server field is the follow-up, not something to fake here.
 *
 * Everything in this file is pure. The rules that matter:
 *
 *  - an id the stored order has never seen sorts FIRST, in the incoming list's
 *    own order — the list arrives newest-first, so a course created after the
 *    last drag lands at the top where the user will look for it, instead of
 *    silently at the bottom;
 *  - an id the stored order still holds but the list no longer has is dropped;
 *  - a stored order is untrusted input (it outlives releases and can be
 *    hand-edited), so nothing here throws on duplicates, holes or garbage — the
 *    worst a corrupt entry can do is give the shipped order back.
 */

/** localStorage keys. Same `openmaic:workspace:` namespace as the rail width. */
export const COURSE_ORDER_STORAGE_KEY = 'openmaic:workspace:course-order';
export const SESSION_ORDER_STORAGE_KEY = 'openmaic:workspace:session-order';

/** Where a dragged row is being dropped, relative to the row under the pointer. */
export type DropTarget = { readonly before: string } | { readonly after: string };

/**
 * Apply a stored order to a live list.
 *
 * Items the order does not mention keep their incoming position at the FRONT
 * (see the header): the list is newest-first, so "unknown" and "new" are the
 * same thing in practice and both belong at the top.
 */
export function applyCustomOrder<T extends { readonly id: string }>(
  items: readonly T[],
  order: readonly string[],
): readonly T[] {
  if (order.length === 0) return items;

  const rank = new Map<string, number>();
  for (const id of order) if (!rank.has(id)) rank.set(id, rank.size);

  // Nothing in the list is ranked → the order is entirely stale. Returning the
  // ORIGINAL reference (not a copy) keeps callers memoising on identity quiet.
  let ranked = 0;
  for (const item of items) if (rank.has(item.id)) ranked += 1;
  if (ranked === 0) return items;

  const unknown: T[] = [];
  const known: T[] = [];
  for (const item of items) (rank.has(item.id) ? known : unknown).push(item);
  known.sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
  return [...unknown, ...known];
}

/**
 * Move `dragId` next to the target row and return the whole new sequence.
 *
 * `ids` is the FLAT display sequence of everything of that kind (every folder's
 * members, then the unfiled ones, then the saved ones — or every session), not
 * just the sub-list being dragged in. Dropping is always expressed relative to
 * a concrete neighbour, so a move inside one folder cannot disturb any other
 * list: the item simply lands beside a row that is already in that list.
 *
 * A no-op drop (onto itself) returns the input unchanged rather than a
 * shuffled copy, so a click that was mistaken for a drag costs nothing.
 */
export function reorderIds(
  ids: readonly string[],
  dragId: string,
  target: DropTarget,
): readonly string[] {
  const anchorId = 'before' in target ? target.before : target.after;
  if (anchorId === dragId) return ids;
  if (!ids.includes(dragId) || !ids.includes(anchorId)) return ids;

  const rest = ids.filter((id) => id !== dragId);
  const anchor = rest.indexOf(anchorId);
  const at = 'before' in target ? anchor : anchor + 1;
  const next = [...rest.slice(0, at), dragId, ...rest.slice(at)];
  // Same sequence in, same reference out: a drag that ends where it started
  // must not rewrite storage or re-render the tree.
  return sameSequence(ids, next) ? ids : next;
}

/** Drop ids the live list no longer has, and collapse duplicates. */
export function pruneOrder(
  order: readonly string[],
  liveIds: readonly string[],
): readonly string[] {
  const live = new Set(liveIds);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of order) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return sameSequence(order, next) ? order : next;
}

/**
 * Parse a persisted order. Anything that is not an array of strings — a stale
 * shape, a truncated write, a hand-edited entry — degrades to "no custom
 * order" rather than throwing during hydration.
 */
export function parseOrder(stored: string | null): readonly string[] {
  if (!stored) return EMPTY_ORDER;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return EMPTY_ORDER;
    const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
    return ids.length > 0 ? dedupe(ids) : EMPTY_ORDER;
  } catch {
    return EMPTY_ORDER;
  }
}

export function serializeOrder(order: readonly string[]): string {
  return JSON.stringify(order);
}

/**
 * Which side of a row the pointer is on — the whole drop model, in one line of
 * arithmetic. Above the midpoint inserts before the row, below it after, so
 * every pixel of every row resolves to a drop and there is no dead band.
 */
export function edgeFor(
  pointerY: number,
  rect: { top: number; height: number },
): 'before' | 'after' {
  return pointerY < rect.top + rect.height / 2 ? 'before' : 'after';
}

const EMPTY_ORDER: readonly string[] = [];

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sameSequence(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
