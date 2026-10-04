/**
 * A run started or discarded in one tab reaches the course lists of the
 * browser's other tabs at once, rather than at their next idle read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  announceRunsChanged,
  subscribeRunsChanged,
} from '@/lib/generation-run-client/runs-changed';
import { pendingCourseRuns, runsByCourse } from '@/lib/generation-run-client/course-card';

const unsubscribers: Array<() => void> = [];
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
});

describe('runs changed in another tab', () => {
  it('reaches a subscriber', async () => {
    const onChange = vi.fn();
    unsubscribers.push(subscribeRunsChanged(onChange));
    announceRunsChanged();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });

  it('stops reaching it once unsubscribed', async () => {
    const onChange = vi.fn();
    subscribeRunsChanged(onChange)();
    const witness = vi.fn();
    unsubscribers.push(subscribeRunsChanged(witness));
    announceRunsChanged();
    await vi.waitFor(() => expect(witness).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('which runs a course list shows on their own', () => {
  const runs = [
    { id: 'run-a', stageId: null },
    { id: 'run-b', stageId: 'stage-b' },
    { id: 'run-c', stageId: 'stage-c' },
  ];

  it('the runs whose course is not listed yet, in the runs order', () => {
    expect(pendingCourseRuns(runs, new Set(['stage-c'])).map((run) => run.id)).toEqual([
      'run-a',
      'run-b',
    ]);
  });

  it('the others are found by their course', () => {
    expect([...runsByCourse(runs).keys()]).toEqual(['stage-b', 'stage-c']);
  });
});
