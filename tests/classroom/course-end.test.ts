import { describe, expect, it } from 'vitest';
import type { CompleteSummary } from '@/lib/classroom/complete-summary';
import {
  courseEndActions,
  opensOnNext,
  opensOnPlaybackEnd,
  opensOnQuizSubmit,
  tiltAllowed,
} from '@/lib/classroom/course-end';
import { PENDING_SCENE_ID, resolveLoadedSceneId } from '@/lib/store/stage';

const summary = (over: Partial<CompleteSummary> = {}): CompleteSummary => ({
  countsByType: {},
  quiz: null,
  unattemptedQuizIds: [],
  firstWrongQuizId: null,
  ...over,
});
const scored = (correct: number, total: number, over: Partial<CompleteSummary> = {}) =>
  summary({
    quiz: { correct, total, pct: Math.round((correct / total) * 100) },
    firstWrongQuizId: correct < total ? 'q1' : null,
    ...over,
  });

describe('courseEndActions', () => {
  it('reviews wrong answers first when there are any', () => {
    expect(courseEndActions(scored(4, 6))).toEqual(['reviewWrong', 'restart']);
  });
  it('offers only a restart for a clean finish', () => {
    expect(courseEndActions(scored(6, 6))).toEqual(['restart']);
    expect(courseEndActions(summary())).toEqual(['restart']);
  });
  it('sends to the quizzes left, and never offers more than two', () => {
    expect(courseEndActions(summary({ unattemptedQuizIds: ['q'] }))).toEqual(['doQuiz', 'restart']);
    expect(courseEndActions(scored(1, 2, { unattemptedQuizIds: ['q'] }))).toEqual([
      'doQuiz',
      'reviewWrong',
    ]);
  });
});

describe('triggers', () => {
  const ctx = { courseComplete: true, onLastPage: true, busy: false, fired: false };

  it('opens when a slide on the last page finishes', () => {
    expect(opensOnPlaybackEnd(ctx, 'slide')).toBe(true);
  });
  it('waits for the learner on a quiz or interactive last page', () => {
    expect(opensOnPlaybackEnd(ctx, 'quiz')).toBe(false);
    expect(opensOnPlaybackEnd(ctx, 'interactive')).toBe(false);
    expect(opensOnQuizSubmit(ctx)).toBe(true);
    expect(opensOnNext(ctx)).toBe(true);
  });
  it('holds back mid-discussion, elsewhere and before the course is done', () => {
    for (const over of [{ busy: true }, { onLastPage: false }, { courseComplete: false }]) {
      expect(opensOnPlaybackEnd({ ...ctx, ...over }, 'slide')).toBe(false);
      expect(opensOnNext({ ...ctx, ...over })).toBe(false);
    }
  });
  it('opens by itself once a playthrough, and by hand as often as asked', () => {
    const fired = { ...ctx, fired: true };
    expect(opensOnPlaybackEnd(fired, 'slide')).toBe(false);
    expect(opensOnQuizSubmit(fired)).toBe(false);
    expect(opensOnNext(fired)).toBe(true);
  });
  it('tilts only with motion on and a real pointer', () => {
    expect(tiltAllowed(false, true)).toBe(true);
    expect(tiltAllowed(true, true)).toBe(false);
    expect(tiltAllowed(false, false)).toBe(false);
  });
});

describe('resolveLoadedSceneId', () => {
  const scenes = [{ id: 'a' }, { id: 'b' }];
  it('moves a saved completion slot to the last page', () => {
    expect(resolveLoadedSceneId(PENDING_SCENE_ID, scenes, [])).toBe('b');
  });
  it('keeps the slot while a page is still being generated', () => {
    expect(resolveLoadedSceneId(PENDING_SCENE_ID, scenes, [{}])).toBe(PENDING_SCENE_ID);
  });
  it('leaves an empty deck, and any real page, alone', () => {
    expect(resolveLoadedSceneId(PENDING_SCENE_ID, [], [])).toBe(PENDING_SCENE_ID);
    expect(resolveLoadedSceneId('a', scenes, [])).toBe('a');
  });
});
