import { describe, expect, it } from 'vitest';

import {
  courseRunHref,
  courseRunStatus,
  pendingCourseName,
} from '@/lib/generation-run-client/course-card';
import { previewStepIds, previewStepIndex } from '@/lib/generation-run-client/preview-steps';
import { mergeOwnerRun } from '@/lib/generation-run-client/use-owner-runs';
import { failedOutlinesOfRun, runIdOfCourse } from '@/lib/generation-run-client/use-run-course';
import { applyRunEvent, viewFromSnapshot } from '@/lib/generation-run-client/reducer';

import { event, outline, snapshot } from './fixtures';

describe('course cards of runs', () => {
  it('say outlining, waiting for confirmation, generating n/m or paused', () => {
    expect(courseRunStatus(snapshot({ state: 'preparing' }))).toEqual({ kind: 'outlining' });
    expect(courseRunStatus(snapshot({ state: 'outlining' }))).toEqual({ kind: 'outlining' });
    expect(courseRunStatus(snapshot({ state: 'awaiting_outline_confirmation' }))).toEqual({
      kind: 'awaiting-confirmation',
    });
    expect(
      courseRunStatus(
        snapshot({ state: 'generating', progress: { scenesTotal: 8, scenesCompleted: 3 } }),
      ),
    ).toEqual({ kind: 'generating', completed: 3, total: 8 });
    expect(courseRunStatus(snapshot({ state: 'paused' }))).toEqual({ kind: 'paused' });
    expect(courseRunStatus(snapshot({ state: 'completed' }))).toBeNull();
  });

  it('open the review while waiting and the classroom once the course exists', () => {
    expect(courseRunHref(snapshot({ state: 'awaiting_outline_confirmation' }))).toBe(
      '/generation-preview?run=run-AAAAAAAAAAAAAAAA',
    );
    expect(courseRunHref(snapshot({ state: 'generating', stageId: 'stage-1' }))).toBe(
      '/classroom/stage-1',
    );
    expect(courseRunHref(snapshot({ state: 'paused' }))).toBe(
      '/generation-preview?run=run-AAAAAAAAAAAAAAAA',
    );
  });

  it('name a pending course by its title, else its requirement', () => {
    expect(pendingCourseName(snapshot())).toBe('Photosynthesis');
    expect(
      pendingCourseName(
        snapshot({
          outline: {
            outlines: [],
            languageDirective: '',
            courseTitle: 'Light',
            taskEngineMode: false,
            revision: 1,
          },
        }),
      ),
    ).toBe('Light');
  });

  it('keep the newest snapshot of each run and drop finished runs', () => {
    const a = snapshot({ id: 'run-a', seq: 3, state: 'outlining' });
    const b = snapshot({ id: 'run-b', seq: 1 });
    let runs = mergeOwnerRun([a, b], { ...a, seq: 5, state: 'awaiting_outline_confirmation' });
    expect(runs.map((run) => [run.id, run.state])).toEqual([
      ['run-a', 'awaiting_outline_confirmation'],
      ['run-b', 'preparing'],
    ]);
    // A stale frame does not roll a run back.
    runs = mergeOwnerRun(runs, { ...a, seq: 4, state: 'outlining' });
    expect(runs[0]!.state).toBe('awaiting_outline_confirmation');
    runs = mergeOwnerRun(runs, { ...a, seq: 9, state: 'completed' });
    expect(runs.map((run) => run.id)).toEqual(['run-b']);
    runs = mergeOwnerRun(runs, snapshot({ id: 'run-c', seq: 1 }));
    expect(runs.map((run) => run.id)).toEqual(['run-c', 'run-b']);
  });
});

describe('preview steps of a run', () => {
  const steps = previewStepIds({ webSearch: false, autoAgents: true });
  it('list the classic steps the run takes', () => {
    expect(steps).toEqual(['outline', 'agent-generation', 'slide-content', 'actions']);
    expect(previewStepIds({ webSearch: true, autoAgents: false })).toEqual([
      'web-search',
      'outline',
      'slide-content',
      'actions',
    ]);
  });

  it('map run steps onto them', () => {
    const at = (state: string, step: string | null) =>
      steps[previewStepIndex({ state: state as never, step }, steps)];
    // The material analysis is not a step of its own: it shows as the one after it.
    expect(at('preparing', 'material-analysis')).toBe('outline');
    expect(at('paused', 'material-analysis')).toBe('outline');
    expect(at('preparing', null)).toBe('outline');
    const withSearch = previewStepIds({ webSearch: true, autoAgents: true });
    expect(
      withSearch[previewStepIndex({ state: 'preparing', step: 'material-analysis' }, withSearch)],
    ).toBe('web-search');
    // Research without a web-search step shows as the outline.
    expect(at('preparing', 'research')).toBe('outline');
    expect(at('outlining', 'outline')).toBe('outline');
    expect(at('awaiting_outline_confirmation', null)).toBe('outline');
    expect(at('generating', null)).toBe('agent-generation');
    expect(at('generating', 'agents')).toBe('agent-generation');
    expect(at('generating', 'scene:0:content')).toBe('slide-content');
    expect(at('generating', 'scene:0:actions')).toBe('actions');
    expect(at('generating', 'scene:0:narration')).toBe('actions');
    expect(at('paused', 'scene:0:content')).toBe('slide-content');
  });
});

describe('the classroom of a run course', () => {
  it('knows a run course by its producer', () => {
    expect(runIdOfCourse('server-job', 'run-AAAAAAAAAAAAAAAA')).toBe('run-AAAAAAAAAAAAAAAA');
    expect(runIdOfCourse('server-job', 'session-1')).toBeNull();
    expect(runIdOfCourse('client', 'run-AAAAAAAAAAAAAAAA')).toBeNull();
    expect(runIdOfCourse(null, null)).toBeNull();
  });

  it('shows a paused run’s failed scenes with Retry, and none while it generates', () => {
    const outlines = [outline(1), outline(2), outline(3)];
    const ready = { outlines, languageDirective: 'en', taskEngineMode: false, revision: 1 };
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 1, outline: ready }));
    view = applyRunEvent(
      view,
      event(2, 'step_failed', { step: 'scene:2:content', message: 'x', continuing: true }),
    );
    expect(failedOutlinesOfRun(view, outlines)).toEqual([]);
    view = applyRunEvent(view, event(3, 'step_failed', { step: 'scene:1:actions', message: 'y' }));
    view = applyRunEvent(view, event(4, 'state', { state: 'paused', step: 'scene:1:actions' }));
    expect(failedOutlinesOfRun(view, outlines).map((o) => o.id)).toEqual(['o2', 'o3']);
  });
});
