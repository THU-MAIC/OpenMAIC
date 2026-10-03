import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAutoContinue,
  nextPreviewPhase,
  OUTLINE_REVIEW_AUTO_CONTINUE_MS,
  type PreviewPhaseInput,
} from '@/lib/generation-run-client/outline-review';
import type { SceneOutline } from '@/lib/types/generation';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const waiting: PreviewPhaseInput = {
  phase: 'progress',
  state: 'awaiting_outline_confirmation',
  outlineStreaming: false,
  hasOutline: true,
  firstAttach: false,
  startedHere: true,
  reviewOutlineEnabled: false,
  reviewIntent: false,
  confirmConflict: false,
};

describe('the outline review of a waiting run', () => {
  it('auto-continues only in the tab whose composer started the run', () => {
    expect(nextPreviewPhase(waiting)).toEqual({
      phase: 'outline-ready',
      armAutoContinue: true,
      cancelAutoContinue: false,
    });
    // Another tab, even one that watched the outline stream: the review.
    expect(nextPreviewPhase({ ...waiting, startedHere: false })).toEqual({
      phase: 'review',
      armAutoContinue: false,
      cancelAutoContinue: true,
    });
    expect(nextPreviewPhase({ ...waiting, startedHere: false, firstAttach: true }).phase).toBe(
      'review',
    );
  });

  it('reviews when the learner asked to', () => {
    expect(nextPreviewPhase({ ...waiting, reviewOutlineEnabled: true }).phase).toBe('review');
    expect(nextPreviewPhase({ ...waiting, reviewIntent: true }).phase).toBe('review');
  });

  it('reopens the review after a reload mid-stream, and leaves the phase alone once chosen', () => {
    expect(
      nextPreviewPhase({
        ...waiting,
        state: 'outlining',
        outlineStreaming: true,
        hasOutline: false,
        firstAttach: true,
        reviewIntent: true,
      }).phase,
    ).toBe('review');
    expect(nextPreviewPhase({ ...waiting, phase: 'review' })).toMatchObject({
      phase: 'review',
      armAutoContinue: false,
    });
  });

  it('moves on when the outline is confirmed elsewhere, unless this page lost the race with edits', () => {
    const generating = { ...waiting, state: 'generating' };
    expect(nextPreviewPhase({ ...generating, phase: 'outline-ready' })).toEqual({
      phase: 'progress',
      armAutoContinue: false,
      cancelAutoContinue: true,
    });
    expect(nextPreviewPhase({ ...generating, phase: 'review' }).phase).toBe('progress');
    expect(nextPreviewPhase({ ...generating, phase: 'review', confirmConflict: true }).phase).toBe(
      'review',
    );
    expect(nextPreviewPhase({ ...waiting, phase: 'review', state: 'paused' }).phase).toBe(
      'progress',
    );
  });

  it('confirms what it was armed with last, once, and nothing after it is cancelled', () => {
    const confirm = vi.fn<(edits: SceneOutline[] | null) => void>();
    const auto = createAutoContinue(confirm);
    auto.arm(null);
    vi.advanceTimersByTime(OUTLINE_REVIEW_AUTO_CONTINUE_MS - 1);
    // The learner opens the review in the last moment: nothing is confirmed.
    auto.cancel();
    vi.advanceTimersByTime(OUTLINE_REVIEW_AUTO_CONTINUE_MS);
    expect(confirm).not.toHaveBeenCalled();
    // Collapsing the edited review re-arms with the edits.
    const edits = [{ id: 'o1', title: 'Edited' } as SceneOutline];
    auto.arm(edits);
    vi.advanceTimersByTime(OUTLINE_REVIEW_AUTO_CONTINUE_MS);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(edits);
    expect(auto.armed()).toBe(false);
  });
});
