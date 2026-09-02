/**
 * A course opened on its own gets a conversation beside it — but never a NEW one.
 *
 * `/workspace?course=<id>` — clicking a classroom in the navigation tree, or
 * pasting its link — used to mount the classroom pane with NO chat, so the Pro
 * bench sat there with no agent to talk to. It then went the other way and MINTED
 * a conversation on arrival, which is what this module now exists to stop:
 * opening a course, closing the chat, and opening the course again left a trail
 * of empty sessions in the rail, one per visit.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 *
 * 1. A conversation is already in the middle column → use it, whatever it is
 *    about.
 * 2. The user explicitly asked for a new one → an empty composer, and nothing is
 *    created until they send something. This outranks 3 for a reason: the most
 *    recent conversation IS the one they just asked to leave.
 * 3. None, and none asked for → carry the user's MOST RECENT conversation over.
 *    "Independent columns" means the middle one keeps the conversation you were
 *    having; it does not mean it empties itself every time you look at a
 *    different course.
 * 4. No conversations at all → mint NOTHING. The column shows an empty composer,
 *    and the session is created by the first message the user sends
 *    (`lib/workbench/first-message-session`).
 *
 * What it deliberately does NOT do is look for "the session that owns this
 * course". That matching version (newest session whose `stageId === courseId`)
 * was an ownership inference, and the panes are being pulled apart precisely so
 * that inference stops existing: an agent is pointed at a classroom by being TOLD
 * (an explicit course mention), not by a stage id happening to match. Silently swapping the user's
 * open conversation for another one about the course they just clicked is the two
 * columns becoming one object again.
 *
 * Nothing here needs an idempotence guard any more, and that is the point: with
 * no POST on arrival there is no in-flight window to coalesce and no
 * just-created-but-not-yet-in-the-URL window to remember. There is also nothing
 * for the server to refuse — a course you may not touch simply has no
 * conversation minted for it, because none is minted for anybody.
 */

export type CourseChatBootstrap =
  /** Nothing to do: no course open, or a conversation is already there. */
  | { readonly kind: 'settled' }
  /** Carry this existing conversation into the middle column. */
  | { readonly kind: 'adopt'; readonly sessionId: string; readonly courseId: string }
  /**
   * The user has no conversations yet. Show an empty one; it becomes real when
   * they send their first message.
   */
  | { readonly kind: 'draft'; readonly courseId: string };

/** The shape this resolver needs from a session row. */
export interface AdoptableSession {
  readonly id: string;
  readonly updatedAt?: number;
  readonly createdAt?: number;
}

/** How recent a row is, tolerating a list that carries only one of the two stamps. */
function recency(session: AdoptableSession): number {
  return Math.max(Number(session.updatedAt) || 0, Number(session.createdAt) || 0);
}

/**
 * The conversation to carry over: the most recently active one.
 *
 * `updatedAt` rather than `createdAt`, so "the one I was just in" wins over "the
 * one I opened last week and never touched"; the id breaks ties so the choice is
 * deterministic rather than dependent on list order.
 */
export function mostRecentSession<T extends AdoptableSession>(sessions: readonly T[]): T | null {
  let best: T | null = null;
  for (const session of sessions) {
    if (!session.id) continue;
    if (!best) {
      best = session;
      continue;
    }
    const stamp = recency(session);
    const bestStamp = recency(best);
    if (stamp > bestStamp || (stamp === bestStamp && session.id > best.id)) best = session;
  }
  return best;
}

export function resolveCourseChatBootstrap(input: {
  /** The course in the classroom pane (`?course=`). */
  readonly courseId: string | null;
  /** The conversation the URL asks for (`?session=`). */
  readonly sessionId: string | null;
  /**
   * The conversation the store is actually attached to. Usually the same as
   * `sessionId`; it is read as well so the brief window during navigation — when
   * the URL has dropped `?session=` but the store has not detached yet — cannot
   * be mistaken for "there is no conversation".
   */
  readonly attachedSessionId?: string | null;
  /**
   * The user just asked for a NEW conversation while a course was open.
   *
   * Without this, "new chat" beside an open classroom would immediately adopt
   * (rule 2) the very conversation it was meant to leave — the most recent one is
   * the one you were just in — and the button would read as broken. An explicit
   * ask therefore outranks adoption, and nothing is created until the first
   * message, exactly as for a user with no conversations at all.
   */
  readonly newConversationRequested?: boolean;
  /** The owner's conversations, as the rail knows them. */
  readonly sessions: readonly AdoptableSession[];
  /**
   * Has that list actually arrived? Until it has, neither branch is knowable:
   * deciding 'draft' early would flash an empty composer over a user who has
   * fifty conversations.
   */
  readonly sessionsLoaded: boolean;
}): CourseChatBootstrap {
  const {
    courseId,
    sessionId,
    attachedSessionId = null,
    newConversationRequested = false,
    sessions,
    sessionsLoaded,
  } = input;
  if (!courseId) return { kind: 'settled' };
  // A conversation explicitly selected in workspace state is already open. It
  // does not matter which course it is about: that pairing is the user's to
  // make, and this must never replace it.
  if (sessionId) return { kind: 'settled' };
  // Explicit intent outranks the store's one-render-late attachment. Client-side
  // workspace navigation drops `sessionId` immediately; waiting for the stream
  // teardown before showing the draft made New chat briefly remove the whole
  // middle column.
  if (newConversationRequested) return { kind: 'draft', courseId };
  if (attachedSessionId) return { kind: 'settled' };
  if (!sessionsLoaded) return { kind: 'settled' };
  const recent = mostRecentSession(sessions);
  return recent ? { kind: 'adopt', sessionId: recent.id, courseId } : { kind: 'draft', courseId };
}
