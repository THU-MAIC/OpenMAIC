import { describe, expect, it } from 'vitest';
import { courseIdFromHref } from '@/lib/workbench/course-link';

describe('course id from an href', () => {
  it('reads the classroom route', () => {
    expect(courseIdFromHref('/classroom/stage-42')).toBe('stage-42');
    expect(courseIdFromHref('/classroom/stage-42?page=3#top')).toBe('stage-42');
    expect(courseIdFromHref('/classroom/a%20b')).toBe('a b');
  });

  it('reads the workspace course param, whatever else the query carries', () => {
    expect(courseIdFromHref('/workspace?course=stage-42')).toBe('stage-42');
    expect(courseIdFromHref('/workspace?session=s1&course=stage-42')).toBe('stage-42');
  });

  /** A link to somewhere else must never be repainted as a course. */
  it('refuses anything that is not a same-site course link', () => {
    expect(courseIdFromHref('https://example.com/classroom/stage-42')).toBeNull();
    expect(courseIdFromHref('//example.com/classroom/stage-42')).toBeNull();
    expect(courseIdFromHref('mailto:someone@example.com')).toBeNull();
    expect(courseIdFromHref('/docs/getting-started')).toBeNull();
    expect(courseIdFromHref('/classroom/')).toBeNull();
    expect(courseIdFromHref('')).toBeNull();
    expect(courseIdFromHref(undefined)).toBeNull();
  });
});
