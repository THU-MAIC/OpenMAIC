/**
 * Lazy conversation creation — the session is born from the first message.
 *
 * Opening a course used to POST a session immediately, which meant every visit to
 * a classroom left another empty conversation in the rail. Nothing is created on
 * arrival any more: the middle column shows an empty composer, and THIS is what
 * runs when the user finally types something.
 *
 * Two existing calls, in order, and no third path:
 *
 *  1. `openWorkbenchForExistingCourse` mints the durable session — idle, no model
 *     turn and no run admission. Merely acquiring a conversation must not start work, and it
 *     must not paint the prompt as a chat bubble either (an idle attach emits
 *     `session_resumed`, not `session_start`, precisely so the first real
 *     `user_message` is the only bubble).
 *  2. `postWorkbenchMessage` delivers the first message through the ORDINARY
 *     message path, which is what makes it an ordinary message: the durable
 *     `user_message` event, its materials, its element refs, its `@`-named
 *     courses, its own run admission, and the requeue that starts the run. The
 *     session-creation endpoint carries none of those — it already tells callers
 *     to "send them on the first message instead" for attachments, and refs are
 *     the same story.
 *
 * The message text is also the session's prompt, so the conversation is named by
 * what was asked in it rather than by whatever course happened to be on screen.
 */

import { openWorkbenchForExistingCourse } from './existing-course';
import { postWorkbenchMessage, type WorkbenchMaterial } from './session-store';
import type { ElementRef } from './element-refs';
import type { CourseRef } from './course-refs';

export interface FirstMessageResult {
  readonly sessionId: string;
  readonly elementRefsAccepted: boolean;
  readonly courseRefsAccepted: boolean;
}

export async function startConversationWithFirstMessage(
  input: {
    /**
     * The classroom on screen. Required: an idle session is minted against a
     * stage, and this flow only exists on a surface that has one open.
     */
    readonly stageId: string;
    readonly text: string;
    readonly materials?: readonly WorkbenchMaterial[];
    readonly elementRefs?: readonly ElementRef[];
    readonly courseRefs?: readonly CourseRef[];
  },
  deps: {
    readonly create?: typeof openWorkbenchForExistingCourse;
    readonly post?: typeof postWorkbenchMessage;
  } = {},
): Promise<FirstMessageResult> {
  const create = deps.create ?? openWorkbenchForExistingCourse;
  const post = deps.post ?? postWorkbenchMessage;
  const meta = await create({ stageId: input.stageId, prompt: input.text });
  const receipt = await post(
    meta.id,
    input.text,
    [...(input.materials ?? [])],
    input.elementRefs ?? [],
    input.courseRefs ?? [],
  );
  return {
    sessionId: meta.id,
    elementRefsAccepted: receipt.elementRefsAccepted,
    courseRefsAccepted: receipt.courseRefsAccepted,
  };
}
