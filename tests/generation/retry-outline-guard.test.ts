/**
 * Regression test for the retrySingleOutline concurrency bug.
 *
 * Before this fix, clicking the per-outline retry button N times in
 * quick succession spun up N parallel content + actions + TTS pipelines
 * for the same outline. Each round burned tokens, raced to write the
 * scene, and produced duplicate IDs in IndexedDB. The fix gates entry
 * on `generatingOutlines` (the same list the UI watches to render the
 * spinner): if the outline is already in flight, the second invocation
 * early-returns without sending a request.
 *
 * The hook itself is a React closure and is exercised end-to-end in
 * Playwright. This test pins the pure predicate that the guard relies
 * on so a regression here is caught immediately at unit-test speed.
 */
import { describe, expect, it } from 'vitest';
import { isOutlineRetryInFlight } from '@/lib/hooks/use-scene-generator';
import type { SceneOutline } from '@/lib/types/generation';

function outline(id: string, order = 0): SceneOutline {
  return {
    id,
    type: 'slide',
    title: `outline-${id}`,
    description: '',
    keyPoints: [],
    order,
  };
}

describe('isOutlineRetryInFlight (Bug #3 retry concurrency guard)', () => {
  it('returns false when no outline is generating', () => {
    expect(isOutlineRetryInFlight({ generatingOutlines: [] }, 'scene-1')).toBe(false);
  });

  it('returns true when the same outline is already in flight', () => {
    expect(isOutlineRetryInFlight({ generatingOutlines: [outline('scene-1')] }, 'scene-1')).toBe(
      true,
    );
  });

  it('returns false when only an unrelated outline is in flight', () => {
    expect(isOutlineRetryInFlight({ generatingOutlines: [outline('scene-2')] }, 'scene-1')).toBe(
      false,
    );
  });

  it('matches by id even when multiple outlines are in flight', () => {
    expect(
      isOutlineRetryInFlight(
        { generatingOutlines: [outline('a'), outline('b'), outline('c')] },
        'b',
      ),
    ).toBe(true);
    expect(
      isOutlineRetryInFlight(
        { generatingOutlines: [outline('a'), outline('b'), outline('c')] },
        'd',
      ),
    ).toBe(false);
  });
});
