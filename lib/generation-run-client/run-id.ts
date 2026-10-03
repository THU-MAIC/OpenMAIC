/**
 * The id of a generation run, as the run API mints it (`run-` and 16 url-safe
 * characters): the one check of whether a course's producer ref names a run
 * the classroom can follow, shared by the load-time fence and the follower.
 */
const RUN_ID = /^run-[A-Za-z0-9_-]{16}$/;

export function isRunRef(ref: string | null | undefined): ref is string {
  return !!ref && RUN_ID.test(ref);
}

/** The run producing a course, from its document's producer fields. */
export function runIdOfCourse(
  producer: string | null | undefined,
  producerRef: string | null | undefined,
): string | null {
  return producer === 'server-job' && isRunRef(producerRef) ? producerRef : null;
}
