export interface ClassroomHeaderControls {
  readonly showHeader: boolean;
  readonly showGlobalControls: boolean;
  readonly showCourseActions: boolean;
}

/**
 * Resolve which HeaderControls scopes belong in the classroom header.
 *
 * A regular classroom keeps its complete header. An embedded workbench
 * classroom removes the header itself. Full-screen workbench playback is the
 * ordinary learning surface, so it restores the complete header; only the
 * embedded editor pane remains compact.
 */
export function resolveClassroomHeaderControls(
  workbenchOpen: boolean,
  workbenchPlayback = false,
): ClassroomHeaderControls {
  if (!workbenchOpen) {
    return { showHeader: true, showGlobalControls: true, showCourseActions: true };
  }
  if (workbenchPlayback) {
    return { showHeader: true, showGlobalControls: true, showCourseActions: true };
  }
  return { showHeader: false, showGlobalControls: false, showCourseActions: false };
}
