/**
 * The course-end state's decisions, free of React, so they can be held to.
 */
import type { SceneType } from '@/lib/types/stage';
import type { CompleteSummary } from './complete-summary';

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

/** How far the course on screen is built, as the classroom can see it. */
export interface CourseBuildState {
  /** The persisted flag. An agent-minted course carries it from birth, before any page. */
  readonly generationComplete: boolean;
  readonly outlineCount: number;
  readonly sceneCount: number;
  /** Outlines the classic generation run still has to turn into pages. */
  readonly generatingCount: number;
  /** A live agent run is writing this course right now. */
  readonly agentBuilding: boolean;
}

/** More pages can still land: a generation run or an agent is still at work. */
export function moreIsComing(state: CourseBuildState): boolean {
  return state.agentBuilding || state.generatingCount > 0;
}

/**
 * The course is finished, so its last page is the end. Never while something is
 * still building it: an agent grows the outline page by page, so between two
 * pages every outline has its scene and the course only looks complete.
 */
export function courseIsComplete(state: CourseBuildState): boolean {
  if (moreIsComing(state)) return false;
  return (
    state.generationComplete || (state.outlineCount > 0 && state.sceneCount === state.outlineCount)
  );
}

/**
 * The learner is at the last page there is and more is on its way, with no
 * placeholder page to step onto: they wait where they are, told the next page is
 * coming, instead of being shown the end.
 */
export function waitsForNextPage(ctx: {
  readonly moreComing: boolean;
  readonly onLastPage: boolean;
  /** A classic run's placeholder page exists for the page being generated. */
  readonly pendingPage: boolean;
}): boolean {
  return ctx.moreComing && ctx.onLastPage && !ctx.pendingPage;
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

/**
 * The build finished while the learner was waiting on its last page: that page
 * was the end after all. A wait begun by pressing next opens it as next would;
 * one begun by the page ending opens it as the page's end would have.
 */
export function opensWhenBuildEnds(ctx: CourseEndContext, byHand: boolean): boolean {
  return byHand ? opensOnNext(ctx) : mayOpenByItself(ctx);
}

export function tiltAllowed(reducedMotion: boolean, finePointer: boolean): boolean {
  return !reducedMotion && finePointer;
}
