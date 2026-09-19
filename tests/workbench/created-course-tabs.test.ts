import { describe, expect, it } from 'vitest';

import { createdCourseTabsToOpen } from '@/lib/workbench/created-course-tabs';

const input = (patch: Partial<Parameters<typeof createdCourseTabsToOpen>[0]> = {}) => ({
  sessionId: 's1',
  createdCourseIds: ['d1', 'd2'],
  replayedCourseCount: 0,
  availableCourseIds: ['d1', 'd2'],
  openCourseIds: [],
  closedCourseIds: [],
  replaying: false,
  ...patch,
});

describe('reconciling created classrooms with tab memory', () => {
  it('opens each still-existing, never-reconciled classroom in creation order', () => {
    expect(createdCourseTabsToOpen(input())).toEqual(['d1', 'd2']);
    expect(createdCourseTabsToOpen(input({ openCourseIds: ['d1', 'd2'] }))).toEqual([]);
    expect(
      createdCourseTabsToOpen(
        input({
          createdCourseIds: ['d1', 'd2', 'd3'],
          availableCourseIds: ['d1', 'd2', 'd3'],
          openCourseIds: ['d1', 'd2'],
        }),
      ),
    ).toEqual(['d3']);
  });

  it('does not restore a deleted classroom or navigate to it', () => {
    expect(
      createdCourseTabsToOpen(
        input({
          createdCourseIds: ['deleted', 'live'],
          availableCourseIds: ['live'],
        }),
      ),
    ).toEqual(['live']);
  });

  it('keeps explicitly closed tabs closed after refresh and A -> B -> A', () => {
    // Reconciliation is independent of an ephemeral per-session cursor. On
    // every revisit, durable open/closed memory accounts for the full history.
    const revisitedA = input({
      createdCourseIds: ['a-open', 'a-closed'],
      availableCourseIds: ['a-open', 'a-closed'],
      openCourseIds: ['a-open'],
      closedCourseIds: ['a-closed'],
    });
    expect(createdCourseTabsToOpen(revisitedA)).toEqual([]);
    expect(createdCourseTabsToOpen(revisitedA)).toEqual([]);
  });

  it('does not replace remembered active state when history is fully reconciled', () => {
    // An empty result means the caller does not call openCourseTabs, so its
    // remembered activeCourseId remains untouched.
    expect(
      createdCourseTabsToOpen(input({ openCourseIds: ['d1'], closedCourseIds: ['d2'] })),
    ).toEqual([]);
  });

  it('holds while replaying and ignores a fold that is not on screen', () => {
    expect(createdCourseTabsToOpen(input({ replaying: true }))).toEqual([]);
    expect(createdCourseTabsToOpen(input({ sessionId: null }))).toEqual([]);
  });

  it('never turns historical chat links into classroom navigation', () => {
    expect(createdCourseTabsToOpen(input({ replayedCourseCount: 2 }))).toEqual([]);
    expect(
      createdCourseTabsToOpen(
        input({
          createdCourseIds: ['historical', 'live'],
          replayedCourseCount: 1,
          availableCourseIds: ['historical', 'live'],
        }),
      ),
    ).toEqual(['live']);
  });
});
