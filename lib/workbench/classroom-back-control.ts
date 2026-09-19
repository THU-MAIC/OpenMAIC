/**
 * What the classroom chrome's top-left back affordance should be, given the
 * Pro workbench attachment state. Single decision point shared by `Stage`
 * (which passes the result down to both chrome roots) so every workbench
 * form resolves the same way:
 *
 * - 'home' — no workbench session attached: the plain classroom keeps its
 *   default back-to-home arrow (`Header`'s fallback, `CommandBar`'s arrow).
 * - 'workbench-return' — full-screen playback (`workbenchOpen &&
 *   workbenchPlayback`): the canvas pager or preview toolbar stepped the
 *   workbench aside, so the classroom header's left slot hosts the back-to-workspace control
 *   (`WorkbenchReturnControl`) that brings the conversation back.
 * - 'hidden' — every other workbench-attached form (embedded panel /
 *   narrow-host overlay): the conversation is already beside or above the
 *   classroom, so a back-to-home arrow would duplicate the workbench chat's
 *   own back affordance AND navigate the user away from the workbench
 *   entirely. No return arrow is rendered at all.
 */
export type ClassroomBackControl = 'home' | 'workbench-return' | 'hidden';

export function resolveClassroomBackControl(
  workbenchOpen: boolean,
  workbenchPlayback: boolean,
): ClassroomBackControl {
  if (!workbenchOpen) return 'home';
  return workbenchPlayback ? 'workbench-return' : 'hidden';
}
