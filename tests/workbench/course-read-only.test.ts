import { describe, expect, it } from 'vitest';

import { isCourseReadOnly, resolveCourseAccess } from '@/lib/workbench/course-read-only';
import type { StageMetaResult } from '@/lib/classroom/stage-meta-client';

const found = (isOwner: boolean): StageMetaResult => ({
  outcome: 'found',
  meta: { isOwner, isPublic: false, publishedAt: null, generationComplete: true },
});

describe('resolveCourseAccess', () => {
  it('a course in the viewer’s own list is theirs, without asking', () => {
    expect(resolveCourseAccess({ listedIsOwner: true, meta: null })).toBe('owner');
    // The list wins over a stale answer.
    expect(resolveCourseAccess({ listedIsOwner: true, meta: found(false) })).toBe('owner');
  });

  it('a course saved from Discover is listed, and not theirs', () => {
    expect(resolveCourseAccess({ listedIsOwner: false, meta: null })).toBe('viewer');
  });

  it('a course not in the list is theirs when the server says so', () => {
    expect(resolveCourseAccess({ listedIsOwner: undefined, meta: found(true) })).toBe('owner');
  });

  it('a course not in the list is someone else’s when the server says so', () => {
    expect(resolveCourseAccess({ listedIsOwner: undefined, meta: found(false) })).toBe('viewer');
    expect(resolveCourseAccess({ listedIsOwner: undefined, meta: { outcome: 'absent' } })).toBe(
      'viewer',
    );
  });

  it('is unknown while the server has not answered, or could not', () => {
    expect(resolveCourseAccess({ listedIsOwner: undefined, meta: null })).toBe('unknown');
    expect(
      resolveCourseAccess({ listedIsOwner: undefined, meta: { outcome: 'unavailable' } }),
    ).toBe('unknown');
  });
});

describe('isCourseReadOnly', () => {
  it('lets the owner edit a course a generation run produced', () => {
    expect(isCourseReadOnly({ access: 'owner', generating: false })).toBe(false);
  });

  it('is read-only for someone else’s course, and while access is unknown', () => {
    expect(isCourseReadOnly({ access: 'viewer', generating: false })).toBe(true);
    expect(isCourseReadOnly({ access: 'unknown', generating: false })).toBe(true);
  });

  it('is read-only while the course is being generated', () => {
    expect(isCourseReadOnly({ access: 'owner', generating: true })).toBe(true);
  });
});
