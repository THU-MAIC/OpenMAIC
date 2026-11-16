/**
 * What sits beside a course in the classroom pane: a conversation, an empty
 * one, or nothing yet — and never a NEW session minted on arrival.
 *
 * `/workspace?course=<id>` used to mount the classroom with no chat, then went
 * the other way and MINTED a conversation per visit (a trail of empty sessions
 * in the rail), then carried the user's most recent conversation over. That
 * last one read wrongly: with conversation A open, browsing to an unrelated
 * course B put A's chat beside B, as if A were editing B.
 *
 * How a course came to be open is now the whole question, and the URL carries
 * the answer:
 *
 * - Opened FROM a conversation (a course card's Open in the chat, the request
 *   preview turning into the course's tab, an `@`-named course, a link the agent
 *   posts): the conversation stays in `?session=` beside it.
 * - Opened by BROWSING (My courses and its search, the global search, any
 *   library-style entry, a pasted or reloaded `?course=` link): the shell drops
 *   `?session=`, and the course is shown alone, the chat column folded. That is
 *   a view state of this open, not the remembered fold preference. The previous
 *   conversation stays in the rail where it was.
 *
 * ── The rules ────────────────────────────────────────────────────────────
 *
 * 1. No course → nothing to decide.
 * 2. A conversation in `?session=` → it stays, whatever it is about. That
 *    pairing is the user's (or the conversation's own) to make.
 * 3. The user asked to talk about this course — the classroom header's "Edit
 *    with AI", the folded column's own unfold, New chat, a hand-over → an EMPTY
 *    conversation beside the course. Nothing is created until the first message
 *    (`lib/workbench/first-message-session`), and the session it creates is
 *    started beside an existing course, so no new-course preview appears.
 * 4. Otherwise the course was browsed → `browse`: the course alone, the chat
 *    column folded, with the way to rule 3 on offer. Nothing is minted and
 *    nothing is carried over.
 *
 * What it deliberately does NOT do is look for "the session that owns this
 * course" (newest session whose `stageId === courseId`): an agent is pointed at
 * a classroom by being TOLD (an explicit course mention), not by a stage id
 * happening to match. Nor does it carry the most recent conversation over any
 * more — that was the same inference, made for whichever conversation was
 * newest.
 *
 * There is nothing to make idempotent and nothing for the server to refuse:
 * nothing here writes.
 */

export type CourseChatBootstrap =
  /** Nothing to do: no course open, or a conversation is already beside it. */
  | { readonly kind: 'settled' }
  /**
   * The course was browsed: shown alone, with the chat column folded and a way
   * to start talking about it.
   */
  | { readonly kind: 'browse'; readonly courseId: string }
  /** An empty conversation beside the course; its first message creates it. */
  | { readonly kind: 'draft'; readonly courseId: string };

export function resolveCourseChatBootstrap(input: {
  /** The course in the classroom pane (`?course=`). */
  readonly courseId: string | null;
  /** The conversation the URL asks for (`?session=`). */
  readonly sessionId: string | null;
  /**
   * The user asked for a conversation about the open course (rule 3): the
   * classroom header's button, the folded column's unfold, New chat.
   *
   * Without it, dropping `?session=` would only ever mean "browse", and New
   * chat beside an open classroom would fold the column instead of offering
   * an empty one.
   */
  readonly newConversationRequested?: boolean;
}): CourseChatBootstrap {
  const { courseId, sessionId, newConversationRequested = false } = input;
  if (!courseId) return { kind: 'settled' };
  if (sessionId) return { kind: 'settled' };
  if (newConversationRequested) return { kind: 'draft', courseId };
  return { kind: 'browse', courseId };
}
