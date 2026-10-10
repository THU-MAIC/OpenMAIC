import { describe, expect, it } from 'vitest';

import { isCourseReadOnly } from '@/lib/workbench/course-read-only';

describe('isCourseReadOnly', () => {
  it('lets the owner edit a course a generation run produced', () => {
    expect(isCourseReadOnly({ isOwner: true, generating: false })).toBe(false);
    expect(isCourseReadOnly({ isOwner: undefined, generating: false })).toBe(false);
  });

  it('is read-only for a course saved from Discover', () => {
    expect(isCourseReadOnly({ isOwner: false, generating: false })).toBe(true);
  });

  it('is read-only while the course is being generated', () => {
    expect(isCourseReadOnly({ isOwner: true, generating: true })).toBe(true);
  });
});
