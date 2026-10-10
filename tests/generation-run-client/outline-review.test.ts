import { describe, expect, it } from 'vitest';

import {
  nextPreviewPhase,
  type PreviewPhaseInput,
} from '@/lib/generation-run-client/outline-review';

const waiting: PreviewPhaseInput = {
  phase: 'progress',
  state: 'awaiting_outline_confirmation',
  outlineReview: 'wait',
  outlineStreaming: false,
  hasOutline: true,
  firstAttach: false,
  reviewIntent: false,
  confirmConflict: false,
};
const countdown: PreviewPhaseInput = { ...waiting, outlineReview: 'countdown' };

describe('the outline review of a run that waits for it', () => {
  it('shows the review once the outline is ready, on any page that attaches', () => {
    expect(nextPreviewPhase(waiting)).toBe('review');
    expect(nextPreviewPhase({ ...waiting, firstAttach: true })).toBe('review');
    expect(nextPreviewPhase({ ...waiting, phase: 'review' })).toBe('review');
  });

  it('shows the streaming card mid-stream, and the review when the learner opened it', () => {
    const streaming = { ...waiting, state: 'outlining', outlineStreaming: true, hasOutline: false };
    expect(nextPreviewPhase(streaming)).toBe('progress');
    // A reload while the learner had the review open mid-stream.
    expect(nextPreviewPhase({ ...streaming, firstAttach: true, reviewIntent: true })).toBe(
      'review',
    );
    expect(nextPreviewPhase({ ...streaming, phase: 'review' })).toBe('review');
  });

  it('moves on when the outline is confirmed elsewhere, unless this page lost the race with edits', () => {
    const generating = { ...waiting, state: 'generating' };
    expect(nextPreviewPhase({ ...generating, phase: 'review' })).toBe('progress');
    expect(nextPreviewPhase({ ...generating, phase: 'review', confirmConflict: true })).toBe(
      'review',
    );
    expect(nextPreviewPhase({ ...waiting, phase: 'review', state: 'paused' })).toBe('progress');
  });
});

describe('the outline of a run that confirms it after a countdown', () => {
  it('shows the outline-ready card while the run counts down, on any page', () => {
    expect(nextPreviewPhase(countdown)).toBe('outline-ready');
    expect(nextPreviewPhase({ ...countdown, firstAttach: true })).toBe('outline-ready');
  });

  it('keeps the review the learner opened (the run is held)', () => {
    expect(nextPreviewPhase({ ...countdown, phase: 'review' })).toBe('review');
    // Held: the run is a waiting one now.
    expect(nextPreviewPhase({ ...waiting, phase: 'review' })).toBe('review');
  });

  it('moves on once the run confirmed its outline', () => {
    const generating = { ...countdown, state: 'generating' };
    expect(nextPreviewPhase({ ...generating, phase: 'outline-ready' })).toBe('progress');
    expect(nextPreviewPhase({ ...generating, phase: 'review', confirmConflict: true })).toBe(
      'review',
    );
  });
});
