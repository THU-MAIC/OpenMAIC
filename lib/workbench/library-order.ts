/**
 * The order of the My courses page: folders and courses as one list, pins,
 * and the manual order over both.
 *
 * Folders and courses are ordered together, so everything here works on typed
 * keys — `course:<id>` and `folder:<id>` — and a folder can never be mistaken
 * for a course with the same id. A stored key without one of those prefixes is
 * a course id from before folders were ordered (or pinned), and is read as
 * `course:<id>`.
 *
 * The default order is most recent activity first: a course's activity is its
 * `updatedAt`; a folder's is the newest `updatedAt` among its courses, or, when
 * it is empty, its own `updatedAt` (else `createdAt`, else 0). Over that sits
 * the per-browser manual order (`workspace-order`, under
 * `COURSE_ORDER_STORAGE_KEY`, now holding typed keys), and over that the pins.
 *
 * A pin is a per-browser view preference in `localStorage` too, stored as two
 * key lists:
 *
 *  - `pinned`: what the user pinned, most recently pinned first;
 *  - `unpinned`: items pinned by default (the seeded guide course, see
 *    `guide-course.ts`) that the user explicitly unpinned.
 *
 * A default-pinned course counts as pinned until it appears in `unpinned`, so
 * a fresh browser shows the guide course at the top without writing anything,
 * whatever id it was derived to for this owner. It sorts after the user's own
 * pins, as the oldest pin.
 *
 * Everything here is pure, and stored values are untrusted input: anything
 * malformed degrades to "no pins" / "no order" rather than throwing.
 */

import { isGuideCourseId } from './guide-course';
import { applyCustomOrder, parseOrder } from './workspace-order';

export const LIBRARY_PINS_STORAGE_KEY = 'openmaic:workspace:course-pins';

// ── Typed keys ────────────────────────────────────────────────────────

export type LibraryKind = 'course' | 'folder';

const COURSE_PREFIX = 'course:';
const FOLDER_PREFIX = 'folder:';

export function courseKey(id: string): string {
  return COURSE_PREFIX + id;
}

export function folderKey(id: string): string {
  return FOLDER_PREFIX + id;
}

/** A key's kind and id. An unprefixed (legacy) key is a course id. */
export function parseKey(key: string): { readonly kind: LibraryKind; readonly id: string } {
  if (key.startsWith(FOLDER_PREFIX)) return { kind: 'folder', id: key.slice(FOLDER_PREFIX.length) };
  if (key.startsWith(COURSE_PREFIX)) return { kind: 'course', id: key.slice(COURSE_PREFIX.length) };
  return { kind: 'course', id: key };
}

/** The typed form of a stored key. */
export function normalizeKey(key: string): string {
  return key.startsWith(FOLDER_PREFIX) || key.startsWith(COURSE_PREFIX) ? key : courseKey(key);
}

/** Read a stored manual order: course-only legacy orders keep applying to courses. */
export function parseLibraryOrder(stored: string | null): readonly string[] {
  const order = parseOrder(stored);
  if (order.length === 0) return order;
  return dedupe(order.map(normalizeKey));
}

// ── Entries ───────────────────────────────────────────────────────────

export type LibraryEntry<C, F> =
  | {
      readonly id: string;
      readonly kind: 'course';
      readonly name: string;
      readonly activity: number;
      readonly course: C;
    }
  | {
      readonly id: string;
      readonly kind: 'folder';
      readonly name: string;
      readonly activity: number;
      readonly folder: F;
    };

interface CourseLike {
  readonly id: string;
  readonly name?: string;
  readonly updatedAt: number;
  readonly folderId?: string | null;
}

interface FolderLike {
  readonly id: string;
  readonly name: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

/**
 * Every folder and every course (filed or not) as one sequence: most recent
 * activity first, then the manual order, then the pins. Views filter this
 * (the top level, one folder, a search) and inherit its order; a drag
 * reorders this whole sequence, so it never disturbs a list off screen.
 */
export function orderLibrary<C extends CourseLike, F extends FolderLike>(
  courses: readonly C[],
  folders: readonly F[],
  order: readonly string[],
  pins: LibraryPins,
  isDefault: DefaultPinned = defaultPinned,
): readonly LibraryEntry<C, F>[] {
  const newest = new Map<string, number>();
  for (const course of courses) {
    if (!course.folderId) continue;
    newest.set(course.folderId, Math.max(newest.get(course.folderId) ?? 0, course.updatedAt));
  }
  const entries: LibraryEntry<C, F>[] = [
    ...folders.map(
      (folder): LibraryEntry<C, F> => ({
        id: folderKey(folder.id),
        kind: 'folder',
        name: folder.name,
        activity: newest.get(folder.id) ?? folder.updatedAt ?? folder.createdAt ?? 0,
        folder,
      }),
    ),
    ...courses.map(
      (course): LibraryEntry<C, F> => ({
        id: courseKey(course.id),
        kind: 'course',
        name: course.name ?? '',
        activity: course.updatedAt,
        course,
      }),
    ),
  ];
  // Stable: equal activity keeps folders before courses, each in list order.
  entries.sort((a, b) => b.activity - a.activity);
  return applyPins(applyCustomOrder(entries, order), pins, isDefault);
}

// ── Pins ──────────────────────────────────────────────────────────────

export interface LibraryPins {
  /** Pinned keys, most recently pinned first. */
  readonly pinned: readonly string[];
  /** Default-pinned keys the user unpinned. */
  readonly unpinned: readonly string[];
}

export const NO_PINS: LibraryPins = { pinned: [], unpinned: [] };

/** Whether an item is pinned without the user ever pinning it. */
export type DefaultPinned = (key: string) => boolean;

/** The seeded guide course is pinned by default. */
export const defaultPinned: DefaultPinned = (key) => {
  const { kind, id } = parseKey(key);
  return kind === 'course' && isGuideCourseId(id);
};

/**
 * The pinned keys among `liveKeys`, in display order: the user's pins first
 * (most recent first), then the default-pinned ones not explicitly unpinned,
 * in the live list's own order.
 */
export function pinnedIds(
  pins: LibraryPins,
  liveKeys: readonly string[],
  isDefault: DefaultPinned = defaultPinned,
): readonly string[] {
  const live = new Set(liveKeys);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of pins.pinned) {
    if (!live.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  const unpinned = new Set(pins.unpinned);
  for (const key of liveKeys) {
    if (seen.has(key) || unpinned.has(key) || !isDefault(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Move the pinned items to the front, in pin order; the rest keep their
 * incoming order. Returns the input reference when nothing is pinned.
 */
export function applyPins<T extends { readonly id: string }>(
  items: readonly T[],
  pins: LibraryPins,
  isDefault: DefaultPinned = defaultPinned,
): readonly T[] {
  const order = pinnedIds(
    pins,
    items.map((item) => item.id),
    isDefault,
  );
  if (order.length === 0) return items;
  const rank = new Map(order.map((key, index) => [key, index]));
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const item of items) (rank.has(item.id) ? pinned : rest).push(item);
  pinned.sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
  return [...pinned, ...rest];
}

export function pinItem(pins: LibraryPins, key: string): LibraryPins {
  return {
    pinned: [key, ...pins.pinned.filter((id) => id !== key)],
    unpinned: pins.unpinned.filter((id) => id !== key),
  };
}

export function unpinItem(
  pins: LibraryPins,
  key: string,
  isDefault: DefaultPinned = defaultPinned,
): LibraryPins {
  const unpinned = pins.unpinned.filter((id) => id !== key);
  return {
    pinned: pins.pinned.filter((id) => id !== key),
    // Only a default pin needs remembering as unpinned; anything else is
    // unpinned simply by not being in `pinned`.
    unpinned: isDefault(key) ? [key, ...unpinned] : unpinned,
  };
}

/**
 * Drop keys the live list no longer has, and duplicates. Returns the input
 * reference when nothing changed, so a caller can skip the write.
 */
export function prunePins(pins: LibraryPins, liveKeys: readonly string[]): LibraryPins {
  const live = new Set(liveKeys);
  const keep = (list: readonly string[]) => {
    const seen = new Set<string>();
    return list.filter((key) => {
      if (!live.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const pinned = keep(pins.pinned);
  const unpinned = keep(pins.unpinned);
  return pinned.length === pins.pinned.length && unpinned.length === pins.unpinned.length
    ? pins
    : { pinned, unpinned };
}

/** Parse a persisted value; anything malformed is "no pins". Bare ids are courses. */
export function parsePins(stored: string | null): LibraryPins {
  if (!stored) return NO_PINS;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_PINS;
    const record = parsed as Record<string, unknown>;
    const keys = (value: unknown): string[] =>
      Array.isArray(value)
        ? dedupe(
            value
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
              .map(normalizeKey),
          )
        : [];
    const pinned = keys(record.pinned);
    const unpinned = keys(record.unpinned);
    return pinned.length === 0 && unpinned.length === 0 ? NO_PINS : { pinned, unpinned };
  } catch {
    return NO_PINS;
  }
}

export function serializePins(pins: LibraryPins): string {
  return JSON.stringify({ pinned: pins.pinned, unpinned: pins.unpinned });
}

function dedupe(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}
