/**
 * The export menu's note to someone viewing a course they do not own: how to
 * get an editable copy of their own today — export the classroom package,
 * then import it into their own courses.
 *
 * Shown only to a viewer (an owner, and every viewer in single-user mode, owns
 * the course), and only when the classroom package export can work for them:
 * a course with project-based (PBL) scenes packages its projects through an
 * owner-scoped server call, so its package is not a viewer's to make.
 */
export function showViewerCopyHint(input: {
  readonly isOwner: boolean;
  readonly scenes: readonly { readonly content?: { readonly type?: string } | null }[];
}): boolean {
  if (input.isOwner) return false;
  return !input.scenes.some((scene) => scene.content?.type === 'pbl');
}
