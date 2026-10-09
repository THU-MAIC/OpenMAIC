import { describe, expect, it } from 'vitest';

import { pendingSceneFailureKey } from '@/lib/generation-run-client/failure-message';
import { applyRunEvent, viewFromSnapshot } from '@/lib/generation-run-client/reducer';
import {
  failedOutlinesOfRun,
  pausedOutlineOfRun,
} from '@/lib/generation-run-client/use-run-course';

import { event, outline, snapshot } from './fixtures';

// Scene index i is outline o<i + 1>.
const outlines = [outline(1), outline(2), outline(3), outline(4)];
const ready = { outlines, languageDirective: 'en', taskEngineMode: false, revision: 1 };

describe('the provider quota guidance of a paused run, in the classroom', () => {
  it('belongs to the scene the run stopped at, not to a scene it went on past', () => {
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 1, outline: ready }));
    // Scene 1's content fails for an ordinary reason and the run goes on past it.
    view = applyRunEvent(
      view,
      event(2, 'step_failed', {
        step: 'scene:1:content',
        message: 'invalid response',
        errorCode: 'GENERATION_FAILED',
        continuing: true,
      }),
    );
    // Scene 3's actions then hit the provider's quota, and the run pauses there.
    view = applyRunEvent(
      view,
      event(3, 'step_failed', {
        step: 'scene:3:actions',
        message: 'insufficient balance',
        errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      }),
    );
    view = applyRunEvent(view, event(4, 'state', { state: 'paused', step: 'scene:3:actions' }));

    // Both scenes get a failure card with Retry ...
    expect(failedOutlinesOfRun(view, outlines).map((o) => o.id)).toEqual(['o2', 'o4']);
    // ... but only scene 3 failed on the quota.
    const stopped = pausedOutlineOfRun(view, outlines);
    expect(stopped?.id).toBe('o4');

    const failure = { errorCode: view.error?.errorCode, outlineId: stopped?.id ?? null };
    // Scene 1 is the first scene not produced, so its card is the pending one:
    // it keeps the generic text.
    expect(pendingSceneFailureKey(failure, 'o2')).toBeUndefined();
    // Once scene 1 is there, scene 3's card says why it failed.
    expect(pendingSceneFailureKey(failure, 'o4')).toBe('generation.quotaExhausted');
    expect(pendingSceneFailureKey(failure, undefined)).toBeUndefined();
    expect(pendingSceneFailureKey(null, 'o4')).toBeUndefined();
  });

  it('is only the provider quota’s', () => {
    expect(
      pendingSceneFailureKey({ errorCode: 'RATE_LIMITED', outlineId: 'o4' }, 'o4'),
    ).toBeUndefined();
    // A host's own quota code is worded by the host.
    expect(
      pendingSceneFailureKey({ errorCode: 'QUOTA_EXHAUSTED', outlineId: 'o4' }, 'o4'),
    ).toBeUndefined();
  });

  it('names no scene for a run that proceeds or stopped outside the scenes', () => {
    let view = viewFromSnapshot(snapshot({ state: 'generating', seq: 1, outline: ready }));
    expect(pausedOutlineOfRun(view, outlines)).toBeNull();

    view = applyRunEvent(
      view,
      event(2, 'step_failed', {
        step: 'agents',
        message: 'insufficient balance',
        errorCode: 'PROVIDER_QUOTA_EXHAUSTED',
      }),
    );
    view = applyRunEvent(view, event(3, 'state', { state: 'paused', step: 'agents' }));
    expect(pausedOutlineOfRun(view, outlines)).toBeNull();
    expect(
      pendingSceneFailureKey({ errorCode: 'PROVIDER_QUOTA_EXHAUSTED', outlineId: null }, 'o1'),
    ).toBeUndefined();
  });
});
