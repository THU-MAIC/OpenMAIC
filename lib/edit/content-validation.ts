import type { SceneOutline } from '@/lib/types/generation';

/** A meaningless state found on a single outline. */
export type OutlineIssue = { kind: 'emptyTitle' };

const isBlank = (s: string | undefined): boolean => !s || s.trim() === '';

/** Content-validity issues on an outline (blank title is the only blocking one). */
export function validateOutline(outline: SceneOutline): OutlineIssue[] {
  return isBlank(outline.title) ? [{ kind: 'emptyTitle' }] : [];
}

/** Whether any outline carries a blocking issue (used to gate generation). */
export function outlinesHaveBlockingIssues(outlines: SceneOutline[]): boolean {
  return outlines.some((o) => validateOutline(o).length > 0);
}

/** Count of outlines with a blocking issue (drives the gate's reason text). */
export function countBlockingOutlines(outlines: SceneOutline[]): number {
  return outlines.reduce((n, o) => n + (validateOutline(o).length > 0 ? 1 : 0), 0);
}
