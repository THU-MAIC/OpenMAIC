import { describe, expect, it } from 'vitest';
import {
  applyPins,
  courseKey,
  folderKey,
  NO_PINS,
  orderLibrary,
  parseKey,
  parseLibraryOrder,
  parsePins,
  pinItem,
  pinnedIds,
  prunableKinds,
  prunePins,
  serializePins,
  unpinItem,
} from '@/lib/workbench/library-order';
import { filterByName } from '@/lib/workbench/workspace-tree';

const GUIDE = 'stage-guide-0123456789abcdef';
const G = courseKey(GUIDE);
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);
const items = (...list: string[]) => list.map((id) => ({ id }));

type C = { id: string; name: string; updatedAt: number; folderId?: string };
type F = { id: string; name: string; createdAt: number; updatedAt: number };
const course = (id: string, updatedAt: number, folderId?: string): C => ({
  id,
  name: id,
  updatedAt,
  folderId,
});
const folder = (id: string, updatedAt = 0): F => ({ id, name: id, createdAt: 0, updatedAt });
/** A short label per entry: `f:<id>` or the course id. */
const labels = (list: readonly { kind: string; id: string }[]) =>
  list.map((entry) =>
    entry.kind === 'folder' ? `f:${parseKey(entry.id).id}` : parseKey(entry.id).id,
  );

describe('typed keys', () => {
  it('keeps folders and courses with the same id apart', () => {
    expect(courseKey('x')).not.toBe(folderKey('x'));
    expect(parseKey(folderKey('x'))).toEqual({ kind: 'folder', id: 'x' });
    expect(parseKey(courseKey('x'))).toEqual({ kind: 'course', id: 'x' });
  });

  it('reads a bare id as a course', () => {
    expect(parseKey('stage-1')).toEqual({ kind: 'course', id: 'stage-1' });
  });
});

describe('orderLibrary: one list of folders and courses', () => {
  const courses = [
    course('a', 10),
    course('b', 50, 'f1'),
    course('c', 30),
    course('d', 20, 'f1'),
    course('e', 5, 'gone'),
  ];
  const folders = [folder('f1', 1), folder('empty', 25), folder('older', 0)];

  it('sorts by most recent activity; a folder by its newest course', () => {
    const all = orderLibrary(courses, folders, [], NO_PINS);
    // A folder ties with its newest course; ties keep folders first.
    expect(labels(all)).toEqual(['f:f1', 'b', 'c', 'f:empty', 'd', 'a', 'e', 'f:older']);
  });

  it('dates an empty folder by its own time, else last', () => {
    const all = orderLibrary([course('a', 10)], [folder('x', 0), folder('y', 20)], [], NO_PINS);
    expect(labels(all)).toEqual(['f:y', 'a', 'f:x']);
  });

  it('applies a manual order over folders and courses together', () => {
    const order = [courseKey('a'), folderKey('f1'), courseKey('c')];
    const top = orderLibrary([course('a', 1), course('c', 3)], [folder('f1', 2)], order, NO_PINS);
    expect(labels(top)).toEqual(['a', 'f:f1', 'c']);
  });

  it('keeps a legacy course-only order working for the courses', () => {
    const order = parseLibraryOrder(JSON.stringify(['a', 'c']));
    expect(order).toEqual([courseKey('a'), courseKey('c')]);
    const top = orderLibrary([course('a', 1), course('c', 3)], [folder('f1', 2)], order, NO_PINS);
    // The folder is new to the order, so it comes first, as anything new does.
    expect(labels(top)).toEqual(['f:f1', 'a', 'c']);
  });

  it('puts pins first: folders and courses share one pin list', () => {
    let pins = pinItem(NO_PINS, courseKey('a'));
    pins = pinItem(pins, folderKey('older'));
    const all = orderLibrary([...courses, course(GUIDE, 0)], folders, [], pins);
    expect(labels(all).slice(0, 4)).toEqual(['f:older', 'a', GUIDE, 'f:f1']);
  });

  it('a pinned folder does not pin its courses', () => {
    const pins = pinItem(NO_PINS, folderKey('f1'));
    const all = orderLibrary(courses, folders, [], pins);
    expect(labels(all).slice(0, 2)).toEqual(['f:f1', 'b']);
    expect(pinnedIds(pins, ids(all))).toEqual([folderKey('f1')]);
  });

  it('search results are mixed, pinned first', () => {
    const pins = pinItem(NO_PINS, courseKey('Algebra II'));
    const all = orderLibrary(
      [course('Algebra I', 9), course('Algebra II', 1), course('Biology', 8)],
      [folder('Algebra', 5)],
      [],
      pins,
    );
    expect(labels(filterByName(all, 'algebra'))).toEqual(['Algebra II', 'Algebra I', 'f:Algebra']);
  });

  it('a folder view keeps its pinned courses first', () => {
    const pins = pinItem(NO_PINS, courseKey('d'));
    const all = orderLibrary(courses, folders, [], pins);
    const inside = all.filter((entry) => entry.kind === 'course' && entry.course.folderId === 'f1');
    expect(labels(inside)).toEqual(['d', 'b']);
  });
});

describe('the guide course', () => {
  it('is pinned by default, with nothing stored', () => {
    expect(ids(applyPins(items('course:a', G), NO_PINS))).toEqual([G, 'course:a']);
  });

  it('sorts after what the user pinned', () => {
    const pins = pinItem(NO_PINS, folderKey('f'));
    expect(ids(applyPins(items('course:a', G, 'folder:f'), pins))).toEqual([
      'folder:f',
      G,
      'course:a',
    ]);
  });

  it('stays unpinned once the user unpins it, through a storage round trip', () => {
    const pins = parsePins(serializePins(unpinItem(NO_PINS, G)));
    expect(pins.unpinned).toEqual([G]);
    expect(pinnedIds(pins, ['course:a', G])).toEqual([]);
  });

  it('can be pinned again after an unpin', () => {
    expect(pinItem(unpinItem(NO_PINS, G), G)).toEqual({ pinned: [G], unpinned: [] });
  });

  it('a folder whose id looks like a guide course is not pinned by default', () => {
    expect(pinnedIds(NO_PINS, [folderKey(GUIDE)])).toEqual([]);
  });

  it('does not remember an ordinary unpin', () => {
    expect(unpinItem(pinItem(NO_PINS, 'folder:f'), 'folder:f')).toEqual({
      pinned: [],
      unpinned: [],
    });
  });
});

describe('prunePins', () => {
  it('drops pins and unpins of items that are gone', () => {
    const pins = { pinned: ['course:a', 'folder:gone', 'folder:f'], unpinned: [G] };
    expect(prunePins(pins, ['course:a', 'folder:f'])).toEqual({
      pinned: ['course:a', 'folder:f'],
      unpinned: [],
    });
  });

  it('returns the same reference when nothing changed', () => {
    const pins = { pinned: ['course:a'], unpinned: [G] };
    expect(prunePins(pins, ['course:a', G])).toBe(pins);
  });

  it('keeps the pins of a kind whose list has not loaded', () => {
    // Courses arrived, folders did not: the live keys hold no folder at all.
    const pins = { pinned: ['folder:f', 'course:gone', 'course:a'], unpinned: [] };
    expect(prunePins(pins, ['course:a'], new Set(['course']))).toEqual({
      pinned: ['folder:f', 'course:a'],
      unpinned: [],
    });
  });

  it('still collapses duplicates of a kind it keeps', () => {
    const pins = { pinned: ['folder:f', 'folder:f'], unpinned: [] };
    expect(prunePins(pins, [], new Set(['course']))).toEqual({
      pinned: ['folder:f'],
      unpinned: [],
    });
  });
});

describe('prunableKinds', () => {
  it('waits while either list is still loading', () => {
    expect(prunableKinds({ course: 'ready', folder: 'loading' })).toBeNull();
    expect(prunableKinds({ course: 'loading', folder: 'ready' })).toBeNull();
  });

  it('prunes both kinds once both lists are ready', () => {
    expect(prunableKinds({ course: 'ready', folder: 'ready' })).toEqual(
      new Set(['course', 'folder']),
    );
  });

  it('prunes only the kinds whose list loaded', () => {
    expect(prunableKinds({ course: 'ready', folder: 'error' })).toEqual(new Set(['course']));
    expect(prunableKinds({ course: 'error', folder: 'ready' })).toEqual(new Set(['folder']));
    expect(prunableKinds({ course: 'ready', folder: null })).toEqual(new Set(['course']));
  });

  it('prunes nothing when no list loaded', () => {
    expect(prunableKinds({ course: 'error', folder: 'error' })).toBeNull();
    expect(prunableKinds({ course: 'error', folder: null })).toBeNull();
  });
});

describe('parsePins', () => {
  it.each([null, '', 'not json', '[]', '"x"', '{"pinned":"a"}', 'null'])(
    'treats %s as no pins',
    (stored) => {
      expect(parsePins(stored)).toEqual(NO_PINS);
    },
  );

  it('reads the earlier bare-id shape as course pins', () => {
    expect(parsePins(JSON.stringify({ pinned: ['a'], unpinned: [GUIDE] }))).toEqual({
      pinned: ['course:a'],
      unpinned: [G],
    });
  });

  it('keeps only non-empty string keys, once each', () => {
    expect(parsePins('{"pinned":["folder:a",1,"","folder:a","b"],"unpinned":[null]}')).toEqual({
      pinned: ['folder:a', 'course:b'],
      unpinned: [],
    });
  });
});
