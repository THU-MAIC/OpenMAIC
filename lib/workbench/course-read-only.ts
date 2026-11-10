/**
 * Whether the workspace shows a course read-only.
 *
 * Ownership comes from the viewer's own course list first: a course in it is
 * theirs, unless it was saved from Discover (`isOwner === false`). A course
 * NOT in the list — a `/workspace?course=` link someone else copied from their
 * address bar, say — is asked about the way the standalone classroom page asks:
 * the stage-meta sidecar's per-viewer `isOwner`. Until that answer arrives the
 * course is read-only: an editable editor that turns out not to be (every save
 * refused) must never flash up, and nothing is lost by waiting.
 *
 * Who produced the document says nothing about it: since generation runs on
 * the server, every generated course records a server producer, and the
 * requesting owner still owns and edits it. A course its generation run is
 * still producing is read-only until the run completes.
 */

import type { StageMetaResult } from '@/lib/classroom/stage-meta-client';

/** The viewer's access to a course: known to be theirs, known not to be, or not yet known. */
export type CourseAccess = 'owner' | 'viewer' | 'unknown';

export function resolveCourseAccess(input: {
  /** `isOwner` from the viewer's course list; undefined when the course is not in it. */
  readonly listedIsOwner: boolean | undefined;
  /** The stage-meta answer for a course not in the list; null while it is pending. */
  readonly meta: StageMetaResult | null;
}): CourseAccess {
  if (input.listedIsOwner === true) return 'owner';
  if (input.listedIsOwner === false) return 'viewer';
  const meta = input.meta;
  if (!meta) return 'unknown';
  if (meta.outcome === 'found') return meta.meta.isOwner ? 'owner' : 'viewer';
  // `absent` is an answer (no such course for anyone to edit); `unavailable`
  // is the lack of one. Neither is a reason to offer editing.
  return meta.outcome === 'absent' ? 'viewer' : 'unknown';
}

export function isCourseReadOnly(input: {
  readonly access: CourseAccess;
  readonly generating: boolean;
}): boolean {
  return input.access !== 'owner' || input.generating === true;
}

/** Where someone else's course is opened: its classroom page, outside the workbench. */
export function classroomHref(courseId: string): string {
  return `/classroom/${encodeURIComponent(courseId)}`;
}
