/**
 * The title the empty conversation's composer names its course by. The rail's
 * list knows the viewer's own courses; a course that is not in it (someone
 * else's shared course, or a built-in one) is named by the document loaded in
 * the classroom pane, and only then by the fallback.
 */
export function draftCourseTitle({
  listedName,
  loadedName,
  fallback,
}: {
  readonly listedName: string | null | undefined;
  readonly loadedName: string | null | undefined;
  readonly fallback: string;
}): string {
  return listedName || loadedName || fallback;
}

/** One ask to name a course in the empty conversation's composer. */
export interface SeedCourseAsk {
  readonly stageId: string;
  readonly title: string;
  readonly ownerId: string | null;
  /** The new-conversation counter: a fresh ask for the same course bumps it. */
  readonly ask: number;
}

/**
 * The seeded mention is being rewritten only because the course's title
 * arrived (or changed) — same course, same composer, same ask. Such a rewrite
 * is cosmetic: it must not move focus or the caret, which belong to wherever
 * the user is now. A new ask, or a different course, does take focus.
 */
export function seedIsTitleOnlyChange(
  previous: SeedCourseAsk | null,
  next: SeedCourseAsk,
): boolean {
  return (
    previous !== null &&
    previous.stageId === next.stageId &&
    previous.ownerId === next.ownerId &&
    previous.ask === next.ask &&
    previous.title !== next.title
  );
}
