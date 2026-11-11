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
