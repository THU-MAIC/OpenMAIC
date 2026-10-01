import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAutoContinue,
  OUTLINE_REVIEW_AUTO_CONTINUE_MS,
  outlineReviewPhase,
} from '@/lib/generation-run-client/outline-review';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('outline review on a waiting run', () => {
  it('reviews when asked to, or when the run was already waiting; else auto-continues', () => {
    const base = { attachedWaiting: false, reviewOutlineEnabled: false, reviewIntent: false };
    expect(outlineReviewPhase(base)).toBe('outline-ready');
    expect(outlineReviewPhase({ ...base, reviewOutlineEnabled: true })).toBe('review');
    expect(outlineReviewPhase({ ...base, reviewIntent: true })).toBe('review');
    expect(outlineReviewPhase({ ...base, attachedWaiting: true })).toBe('review');
  });

  it('confirms 2.5 s after it is armed, once, and not after it is cancelled', () => {
    const confirm = vi.fn();
    const auto = createAutoContinue(confirm);
    auto.arm();
    vi.advanceTimersByTime(OUTLINE_REVIEW_AUTO_CONTINUE_MS - 1);
    expect(confirm).not.toHaveBeenCalled();
    // Re-arming (collapsing the editor again) restarts the beat.
    auto.arm();
    vi.advanceTimersByTime(OUTLINE_REVIEW_AUTO_CONTINUE_MS - 1);
    expect(confirm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(auto.armed()).toBe(false);

    auto.arm();
    auto.cancel();
    vi.advanceTimersByTime(OUTLINE_REVIEW_AUTO_CONTINUE_MS * 2);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
