import { useCourseRefsStore } from '@/lib/store/course-refs';
import type { CourseRef } from '@/lib/workbench/course-refs';

/**
 * Finalize a successful message POST without losing a retryable mention draft.
 * A missing capability receipt means an older route accepted the text but did
 * not carry courseRefs during a rolling deploy — the draft is kept so the user
 * can resend rather than silently losing the course they named.
 *
 * The sibling of `settleSentElementRefs`, and deliberately its exact shape.
 */
export function settleSentCourseRefs({
  sessionId,
  sent,
  courseRefsAccepted,
  warnUnsupported,
}: {
  sessionId: string;
  sent: readonly CourseRef[];
  courseRefsAccepted: boolean;
  warnUnsupported: () => void;
}): void {
  if (sent.length === 0) return;
  if (!courseRefsAccepted) {
    warnUnsupported();
    return;
  }
  useCourseRefsStore.getState().removeSent(sessionId, sent);
}
