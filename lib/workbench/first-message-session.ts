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
 *
 * That is the conversation ABOUT a course (`stageId`: the course the composer
 * named when it opened, still named at send). With no course to be about, the
 * first message starts an ordinary new conversation the way the home composer
 * does — one create that carries the message, its materials and its named
 * courses, and starts the run. Element refs have no place on that path.
 */

import { openWorkbenchForExistingCourse } from './existing-course';
import {
  createWorkbenchSession,
  postWorkbenchMessage,
  type WorkbenchMaterial,
} from './session-store';
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
     * The course this conversation is about: an idle session is minted against
     * it (`existingCourse`). Absent, the conversation is an ordinary new one.
     */
    readonly stageId?: string;
    readonly text: string;
    readonly materials?: readonly WorkbenchMaterial[];
    readonly elementRefs?: readonly ElementRef[];
    readonly courseRefs?: readonly CourseRef[];
    /**
     * The session exists, its first message not yet delivered: lets the
     * caller tell this conversation from any other it may be shown meanwhile.
     */
    readonly onCreated?: (sessionId: string) => void;
  },
  deps: {
    readonly create?: typeof openWorkbenchForExistingCourse;
    readonly post?: typeof postWorkbenchMessage;
    readonly launch?: typeof createWorkbenchSession;
  } = {},
): Promise<FirstMessageResult> {
  if (!input.stageId) {
    const launch = deps.launch ?? createWorkbenchSession;
    const courseRefs = input.courseRefs ?? [];
    const session = await launch({
      prompt: input.text,
      ...(input.materials?.length ? { materials: [...input.materials] } : {}),
      ...(courseRefs.length ? { courseRefs } : {}),
    });
    input.onCreated?.(session.id);
    return {
      sessionId: session.id,
      elementRefsAccepted: (input.elementRefs?.length ?? 0) === 0,
      courseRefsAccepted: session.courseRefsAccepted !== false,
    };
  }
  const create = deps.create ?? openWorkbenchForExistingCourse;
  const post = deps.post ?? postWorkbenchMessage;
  const meta = await create({ stageId: input.stageId, prompt: input.text });
  input.onCreated?.(meta.id);
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
