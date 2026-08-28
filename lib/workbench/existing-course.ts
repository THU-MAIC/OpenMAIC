/**
 * Open the workbench on an already-built classroom.
 *
 * Creates the durable session for a course and starts NO model turn: the row is
 * born `succeeded` (idle) and run admission is skipped, because minting a
 * conversation is not generation and must never be billed as one.
 *
 * The caller supplies the `prompt`, which is what names the conversation in the
 * rail and the pane header. It is deliberately NOT the course's name any more: a
 * conversation titled after a classroom says the two are one object, which is
 * exactly the binding the workspace's two independent columns removed. The one
 * caller left passes the user's first message (see
 * `lib/workbench/first-message-session`), so a conversation is named by what was
 * asked in it — the same rule every conversation started from the launch composer
 * already follows.
 */

import { createWorkbenchSession, type WorkbenchSessionMeta } from './session-store';

export async function openWorkbenchForExistingCourse(input: {
  stageId: string;
  /** What names the conversation. The first message, in practice. */
  prompt: string;
}): Promise<WorkbenchSessionMeta> {
  return createWorkbenchSession({
    prompt: input.prompt,
    stageId: input.stageId,
    existingCourse: true,
  });
}
