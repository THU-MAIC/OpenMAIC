import { describe, expect, test } from 'vitest';
import { supportsNarrationTimeline } from '@/components/edit/scene-timeline';

describe('supportsNarrationTimeline', () => {
  test('registered canvas surfaces (slide/quiz) keep the timeline', () => {
    expect(supportsNarrationTimeline('slide', true)).toBe(true);
    expect(supportsNarrationTimeline('quiz', true)).toBe(true);
  });
  test('interactive/pbl get the timeline even without a canvas surface', () => {
    expect(supportsNarrationTimeline('interactive', false)).toBe(true);
    expect(supportsNarrationTimeline('pbl', false)).toBe(true);
  });
  test('an unknown/unsupported type with no surface gets no timeline', () => {
    expect(supportsNarrationTimeline('unknown' as never, false)).toBe(false);
  });
});
