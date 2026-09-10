/**
 * Reconcile immutable first-seen `stage_link` history (legacy `course_link`
 * replays identically) with the user's durable tab
 * memory and the authoritative classroom list.
 *
 * There is deliberately no in-memory replay cursor here. A cursor starts at
 * zero after refresh and when navigating A -> B -> A, so it cannot distinguish
 * a never-opened stage from a tab the user explicitly closed. The tab memory
 * carries that durable distinction as open ids + closed ids + active id.
 */

export interface CreatedCourseTabsInput {
  /** Null unless the folded session is the session currently on screen. */
  readonly sessionId: string | null;
  /** Ordered, deduplicated, append-only `WorkbenchFold.stageLinkStageIds`. */
  readonly createdCourseIds: readonly string[];
  /** Leading ids reconstructed from history while the chat attached. */
  readonly replayedCourseCount: number;
  /** Current server-backed `courses.classrooms`; deleted stages are absent. */
  readonly availableCourseIds: readonly string[];
  /** Tabs currently open/restored for this session. */
  readonly openCourseIds: readonly string[];
  /** Tabs this user explicitly closed for this session. */
  readonly closedCourseIds: readonly string[];
  /** Hold while the historical event backlog is incomplete. */
  readonly replaying: boolean;
}

const NOTHING: readonly string[] = [];

/**
 * Return only genuinely new LIVE classrooms to add. Replayed links render as
 * transcript cards but never change the independent classroom pane. The shell
 * keeps an already active classroom focused and activates the newest live
 * addition only when the classroom pane was empty.
 */
export function createdCourseTabsToOpen(input: CreatedCourseTabsInput): readonly string[] {
  if (!input.sessionId || input.replaying) return NOTHING;
  const available = new Set(input.availableCourseIds);
  const reconciled = new Set([...input.openCourseIds, ...input.closedCourseIds]);
  const replayedCourseCount = Number.isFinite(input.replayedCourseCount)
    ? Math.max(0, Math.min(Math.trunc(input.replayedCourseCount), input.createdCourseIds.length))
    : 0;
  const liveCourseIds = input.createdCourseIds.slice(replayedCourseCount);
  const open = liveCourseIds.filter(
    (courseId) => available.has(courseId) && !reconciled.has(courseId),
  );
  return open.length > 0 ? open : NOTHING;
}
