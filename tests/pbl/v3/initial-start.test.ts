import { describe, expect, it } from 'vitest';
import { needsInitialStart } from '@/lib/pbl/v3/presentation';
import type { LearningView } from '@/lib/pbl/v3/types';

const unopened = () =>
  ({
    needsOpening: true,
    state: {
      status: 'running',
      position: { milestoneIndex: 0, stageIndex: 0 },
    },
    messages: [],
    roleRun: null,
  }) as unknown as LearningView;

describe('initial project start', () => {
  it('waits even when a peek already created a study or the guide is complete', () => {
    expect(needsInitialStart({ ...unopened(), onboardingCompleted: true })).toBe(true);
    expect(needsInitialStart({ ...unopened(), onboardingCompleted: false })).toBe(true);
  });

  it.each(['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const)(
    'does not gate an existing %s opening, even before its first text',
    (status) => {
      const view = unopened();
      view.roleRun = { status, failure: null, canRetry: false };
      expect(needsInitialStart(view)).toBe(false);
    },
  );

  it('keeps later stages and reset/recovery on their existing entry path', () => {
    const later = unopened();
    later.state.position.stageIndex = 1;
    expect(needsInitialStart(later)).toBe(false);
    later.state.position = { milestoneIndex: 1, stageIndex: 0, milestoneId: 'later' };
    expect(needsInitialStart(later)).toBe(false);
    expect(
      needsInitialStart({
        ...unopened(),
        recovery: { progressReset: true, checkpointRevision: 0 },
      }),
    ).toBe(false);
  });

  it('does not restart a conversation or a completed project', () => {
    expect(
      needsInitialStart({ ...unopened(), messages: [{ role: 'assistant', text: 'Welcome' }] }),
    ).toBe(false);
    expect(needsInitialStart({ ...unopened(), needsOpening: false })).toBe(false);
    const completed = unopened();
    completed.state.status = 'completed';
    expect(needsInitialStart(completed)).toBe(false);
  });
});
