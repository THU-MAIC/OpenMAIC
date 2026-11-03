/**
 * The course-end state's decisions, free of React, so they can be held to.
 *
 * `selectBadgeId` is the seam for a later achievements system: a result goes in and a
 * badge comes out, and the badges themselves are a table (`course-end/badges.tsx`).
 */
import type { SceneType } from '@/lib/types/stage';
import type { CompleteSummary } from './complete-summary';

export type BadgeId = 'amethyst' | 'silver' | 'seedling' | 'seal';

/** From here a score reads as most of the way there. */
const SILVER_FROM_PCT = 50;

export function selectBadgeId(summary: CompleteSummary): BadgeId {
  // A score over part of the quizzes would say something untrue about the course.
  if (summary.unattemptedQuizIds.length > 0 || !summary.quiz) return 'seal';
  if (summary.quiz.pct === 100) return 'amethyst';
  return summary.quiz.pct >= SILVER_FROM_PCT ? 'silver' : 'seedling';
}

export type CourseEndAction = 'reviewWrong' | 'doQuiz' | 'restart';

/** What the card offers, the first the main one, at most two. */
export function courseEndActions(summary: CompleteSummary): CourseEndAction[] {
  const actions: CourseEndAction[] = [];
  if (summary.unattemptedQuizIds.length > 0) actions.push('doQuiz');
  if (summary.firstWrongQuizId) actions.push('reviewWrong');
  if (actions.length < 2) actions.push('restart');
  return actions;
}

/** A page the learner has yet to act on must not be covered when its narration ends. */
export function pageAwaitsLearner(type: SceneType | undefined): boolean {
  return type === 'quiz' || type === 'interactive' || type === 'pbl';
}

export interface CourseEndContext {
  readonly courseComplete: boolean;
  readonly onLastPage: boolean;
  /** A discussion or an interruption is under way. */
  readonly busy: boolean;
  /** It has already opened by itself in this playthrough. */
  readonly fired: boolean;
}

const mayOpenByItself = (ctx: CourseEndContext) =>
  ctx.courseComplete && ctx.onLastPage && !ctx.busy && !ctx.fired;

export function opensOnPlaybackEnd(ctx: CourseEndContext, type: SceneType | undefined): boolean {
  return mayOpenByItself(ctx) && !pageAwaitsLearner(type);
}

export function opensOnQuizSubmit(ctx: CourseEndContext): boolean {
  return mayOpenByItself(ctx);
}

/** Pressing next is asked for by hand, so it reopens as often as it is pressed. */
export function opensOnNext(ctx: CourseEndContext): boolean {
  return ctx.courseComplete && ctx.onLastPage && !ctx.busy;
}

export function tiltAllowed(reducedMotion: boolean, finePointer: boolean): boolean {
  return !reducedMotion && finePointer;
}
