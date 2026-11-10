/**
 * The export menu's note to someone viewing a course they do not own: how to
 * get an editable copy of their own today — export the classroom package,
 * then import it into their own courses.
 *
 * Shown only to a viewer (an owner, and every viewer in single-user mode, owns
 * the course), and only when the classroom package export can work for them:
 * a course with project-based (PBL) scenes packages its projects through an
 * owner-scoped server call, so its package is not a viewer's to make. And only
 * where the workbench is part of the build: the note sends the viewer to My
 * courses, which a build without it does not have.
 */
export function showViewerCopyHint(input: {
  readonly isOwner: boolean;
  readonly workbench: boolean;
  readonly scenes: readonly { readonly content?: { readonly type?: string } | null }[];
}): boolean {
  if (input.isOwner || !input.workbench) return false;
  return !input.scenes.some((scene) => scene.content?.type === 'pbl');
}
