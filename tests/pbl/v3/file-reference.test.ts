import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { createHash } from 'node:crypto';
import { fileReferenceHref, parseFileReference } from '@/lib/pbl/v3/file-reference';
import { changedLineRanges, latestFileChanges } from '@/lib/server/pbl-v3/file-changes';
import type { Queryable } from '@openmaic/storage/document/pg';

describe('workbench file references and version-bound AI changes', () => {
  it('round trips encoded public paths and line ranges', () => {
    expect(parseFileReference(fileReferenceHref('src/我的 file.py', 4, 8))).toEqual({
      path: 'src/我的 file.py',
      line: 4,
      end: 8,
    });
    expect(parseFileReference(fileReferenceHref('PLAN.md'))).toEqual({ path: 'PLAN.md' });
  });
  it.each([
    'https://example.com/#pbl-file=PLAN.md',
    '#pbl-file=../rubric.md',
    '#pbl-file=%2Fetc%2Fpasswd',
    '#pbl-file=src%5Ctest.py',
    '#pbl-file=PLAN.md&line=0',
    '#pbl-file=PLAN.md&line=8&end=2',
    '#pbl-file=PLAN.md&end=3',
    '#pbl-file=PLAN.md&line=NaN',
  ])('rejects unsafe or invalid reference %s', (href) => {
    expect(parseFileReference(href)).toBeNull();
  });
  it('marks only actual inserted/replaced lines, leaving intervening unchanged lines clear', () => {
    expect(changedLineRanges('a\nb\nc\nd\n', 'a\nnew\nb\nc\nD\n')).toEqual([
      { start: 2, end: 2, kind: 'added' },
      { start: 5, end: 5, kind: 'modified' },
    ]);
    expect(changedLineRanges('a\nb\n', 'a\n')).toEqual([{ start: 2, end: 2, kind: 'deleted' }]);
    expect(changedLineRanges('', 'a\nb')).toEqual([{ start: 1, end: 2, kind: 'added' }]);
    expect(changedLineRanges('same', 'same')).toEqual([]);
  });
  it('never decorates stale content, learner edits, or legacy writes without ranges', async () => {
    const changes = [{ start: 2, end: 2, kind: 'added' }];
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ actor: 'coder', detail: { text: 'a\nb', changes } }] });
    const db = { query } as unknown as Queryable;
    const hash = createHash('sha256').update('a\nb').digest('hex');
    expect(await latestFileChanges(db, 'study-a', 'src/a.py', hash)).toEqual(changes);
    expect(query.mock.calls[0]?.[1]).toEqual(['study-a', 'src/a.py']);
    expect(await latestFileChanges(db, 'study-a', 'src/a.py', 'another-version')).toEqual([]);
    query.mockResolvedValue({ rows: [{ actor: 'learner', detail: { text: 'a\nb', changes } }] });
    expect(await latestFileChanges(db, 'study-a', 'src/a.py', hash)).toEqual([]);
    query.mockResolvedValue({ rows: [{ actor: 'planner', detail: { text: 'a\nb' } }] });
    expect(await latestFileChanges(db, 'study-a', 'PLAN.md', hash)).toEqual([]);
  });
});
