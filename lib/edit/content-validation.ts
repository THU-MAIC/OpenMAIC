import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';
import { ELEMENT_BOUND } from '@/components/edit/ActionsBar/cue-meta';

/**
 * Pure content-validity checks for the editor. These surface *meaningless* edit
 * states — an empty speech line, a cue pointing at nothing, a scene with no
 * actions, a titleless outline — so the UI can mark them (scenes, lint-style)
 * or gate a forward step (outline → generate). No UI or store dependencies.
 *
 * Empties are tolerated while editing; this module only *describes* them. Whom
 * to block and where is the caller's policy.
 */

/** A meaningless state tied to a specific action in a scene's timeline. */
export type ActionIssue =
  | { kind: 'emptySpeech'; actionId: string }
  | { kind: 'unboundCue'; actionId: string }
  | { kind: 'emptyDiscussion'; actionId: string };

/** A meaningless state found on a single scene (action-level issues + empty list). */
export type SceneIssue = { kind: 'emptyActions' } | ActionIssue;

/** A meaningless state found on a single outline. */
export type OutlineIssue = { kind: 'emptyTitle' };

const isBlank = (s: string | undefined): boolean => !s || s.trim() === '';

/**
 * Per-action content issues, in timeline order: a blank speech line, a cue that
 * points at no element, a discussion with no topic. Drives the inline marks on
 * the ActionsBar clips.
 */
export function validateActions(actions: Action[]): ActionIssue[] {
  const issues: ActionIssue[] = [];
  for (const a of actions) {
    if (a.type === 'speech' && isBlank((a as { text?: string }).text)) {
      issues.push({ kind: 'emptySpeech', actionId: a.id });
    } else if (ELEMENT_BOUND.has(a.type) && isBlank((a as { elementId?: string }).elementId)) {
      issues.push({ kind: 'unboundCue', actionId: a.id });
    } else if (a.type === 'discussion' && isBlank((a as { topic?: string }).topic)) {
      issues.push({ kind: 'emptyDiscussion', actionId: a.id });
    }
  }
  return issues;
}

/** All content-validity issues on a scene, in action order (empty list first). */
export function validateScene(scene: Scene): SceneIssue[] {
  const actions = (scene.actions ?? []) as Action[];
  if (actions.length === 0) return [{ kind: 'emptyActions' }];
  return validateActions(actions);
}

/** Whether a scene has any content-validity issue. */
export function sceneHasIssues(scene: Scene): boolean {
  return validateScene(scene).length > 0;
}

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
