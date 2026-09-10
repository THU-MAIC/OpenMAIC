import { describe, expect, it } from 'vitest';
import { filterByName, groupCoursesByFolder, matchesQuery } from '@/lib/workbench/workspace-tree';

describe('nav tree name filter', () => {
  it('matches case-insensitively on a substring', () => {
    expect(matchesQuery('Linear Algebra', 'algebra')).toBe(true);
    expect(matchesQuery('Linear Algebra', 'ALG')).toBe(true);
    expect(matchesQuery('Linear Algebra', 'calculus')).toBe(false);
  });

  it('treats an empty or whitespace query as "match everything"', () => {
    expect(matchesQuery('anything', '')).toBe(true);
    expect(matchesQuery('anything', '   ')).toBe(true);
    // An unnamed row still survives an empty query rather than vanishing.
    expect(matchesQuery(undefined, '')).toBe(true);
  });

  it('never matches an unnamed row against a real query', () => {
    expect(matchesQuery(undefined, 'x')).toBe(false);
  });

  it('returns the original array reference when the query is empty', () => {
    const items = [{ name: 'a' }, { name: 'b' }];
    expect(filterByName(items, '  ')).toBe(items);
  });

  it('filters by display name', () => {
    const items = [{ name: '线性代数' }, { name: '微积分' }, { name: 'Calculus' }];
    expect(filterByName(items, 'calc').map((i) => i.name)).toEqual(['Calculus']);
    expect(filterByName(items, '代数').map((i) => i.name)).toEqual(['线性代数']);
  });
});

describe('nav tree folder grouping', () => {
  const folders = [
    { id: 'f1', name: 'Term 1' },
    { id: 'f2', name: 'Term 2' },
  ];

  it('files each course under its folder and keeps the folder list order', () => {
    const tree = groupCoursesByFolder(
      [{ id: 'c1', folderId: 'f2' }, { id: 'c2', folderId: 'f1' }, { id: 'c3' }],
      folders,
    );

    expect(tree.groups.map((g) => g.folder.id)).toEqual(['f1', 'f2']);
    expect(tree.groups[0].courses.map((c) => c.id)).toEqual(['c2']);
    expect(tree.groups[1].courses.map((c) => c.id)).toEqual(['c1']);
    expect(tree.ungrouped.map((c) => c.id)).toEqual(['c3']);
  });

  it('keeps an empty folder in the tree so it can still be opened', () => {
    const tree = groupCoursesByFolder([{ id: 'c1', folderId: 'f1' }], folders);
    expect(tree.groups[1].folder.id).toBe('f2');
    expect(tree.groups[1].courses).toEqual([]);
  });

  it('treats a course pointing at a deleted folder as unfiled, not lost', () => {
    // Same guard DiscoveryAreaLive applies (`!folderNameById.has(...)`): the
    // grid and the tree must not disagree about where a course lives.
    const tree = groupCoursesByFolder([{ id: 'orphan', folderId: 'gone' }], folders);
    expect(tree.ungrouped.map((c) => c.id)).toEqual(['orphan']);
    expect(tree.groups.every((g) => g.courses.length === 0)).toBe(true);
  });

  it('preserves the incoming course order within a folder', () => {
    const tree = groupCoursesByFolder(
      [
        { id: 'newest', folderId: 'f1' },
        { id: 'older', folderId: 'f1' },
      ],
      folders,
    );
    expect(tree.groups[0].courses.map((c) => c.id)).toEqual(['newest', 'older']);
  });
});
