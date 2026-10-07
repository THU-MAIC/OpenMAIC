import { describe, expect, it } from 'vitest';
import {
  paneAvailabilityRetryDelay,
  resolveClassroomSurfaceView,
} from '@/lib/classroom/progressive-load-policy';

describe('progressive classroom policy', () => {
  it('uses a bounded pane availability backoff', () => {
    expect(Array.from({ length: 6 }, (_, attempt) => paneAvailabilityRetryDelay(attempt))).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      null,
    ]);
  });
});

describe('classroom surface view', () => {
  const settledPane = {
    variant: 'pane',
    loading: false,
    error: null,
    notFound: false,
    loadedClassroomId: null,
    classroomId: 'stage-a',
  } as const;

  it('shows not-found after an absent pane load exhausts its retry schedule', () => {
    expect(resolveClassroomSurfaceView({ ...settledPane, notFound: true })).toBe('not-found');
  });

  it('shows Retry after an unavailable pane load exhausts its retry schedule', () => {
    expect(
      resolveClassroomSurfaceView({
        ...settledPane,
        error: 'Could not load this course',
      }),
    ).toBe('error');
  });

  it('keeps showing loading while a non-terminal pane waits for its classroom', () => {
    expect(resolveClassroomSurfaceView(settledPane)).toBe('loading');
  });
});
