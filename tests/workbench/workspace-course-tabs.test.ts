import { describe, expect, it, vi } from 'vitest';
import {
  COURSE_TABS_MAX_STORED_CHARS,
  COURSE_TABS_STORAGE_KEY,
  parseCourseTabsMemory,
  readCourseTabsMemory,
  serializeCourseTabsMemory,
  writeCourseTabsMemory,
} from '@/lib/workbench/workspace-course-tabs';

describe('workspace course tab memory', () => {
  it('round-trips the workspace ordered set and active tab', () => {
    const memory = {
      courseIds: ['one', 'two'],
      activeCourseId: 'two',
      closedCourseIds: ['closed'],
    };
    expect(parseCourseTabsMemory(serializeCourseTabsMemory(memory))).toEqual(memory);
  });

  it('deduplicates ids and rejects invalid active tabs', () => {
    expect(
      parseCourseTabsMemory(JSON.stringify({ courseIds: ['a', 'a', 'b'], activeCourseId: 'b' })),
    ).toEqual({ courseIds: ['a', 'b'], activeCourseId: 'b' });
    expect(
      parseCourseTabsMemory(JSON.stringify({ courseIds: ['a'], activeCourseId: 'gone' })),
    ).toBeNull();
    expect(
      parseCourseTabsMemory(JSON.stringify({ courseIds: [], activeCourseId: null })),
    ).toBeNull();
  });

  it('rejects malformed and oversized payloads without truncating a tab set', () => {
    expect(parseCourseTabsMemory('{bad')).toBeNull();
    expect(parseCourseTabsMemory('x'.repeat(COURSE_TABS_MAX_STORED_CHARS + 1))).toBeNull();
    expect(
      serializeCourseTabsMemory({
        courseIds: ['x'.repeat(COURSE_TABS_MAX_STORED_CHARS)],
        activeCourseId: 'x',
      }),
    ).toBeNull();
  });

  it('retains a close-last tombstone so replay cannot revive the tab', () => {
    expect(
      parseCourseTabsMemory(
        JSON.stringify({ courseIds: [], activeCourseId: null, closedCourseIds: ['a'] }),
      ),
    ).toEqual({ courseIds: [], activeCourseId: null, closedCourseIds: ['a'] });
  });

  it('reads and writes one tab set through the new guarded localStorage key', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    // The legacy key contains Record<sessionId, tabs>; it must never be parsed
    // as the new workspace-wide value.
    values.set(
      'openmaic:workspace:course-tabs',
      JSON.stringify({ chat: { courseIds: ['old'], activeCourseId: 'old' } }),
    );
    expect(readCourseTabsMemory()).toBeNull();

    const memory = { courseIds: ['a'], activeCourseId: 'a' };
    writeCourseTabsMemory(memory);
    expect(values.has(COURSE_TABS_STORAGE_KEY)).toBe(true);
    expect(readCourseTabsMemory()).toEqual(memory);
    writeCourseTabsMemory({ courseIds: [], activeCourseId: null });
    expect(values.has(COURSE_TABS_STORAGE_KEY)).toBe(false);
    expect(values.has('openmaic:workspace:course-tabs')).toBe(true);
    vi.unstubAllGlobals();
  });
});
