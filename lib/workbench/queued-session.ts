/**
 * A conversation whose request is waiting for a free runner (`queued`): the
 * runner has not claimed it, so nothing has started and none of its events
 * exist yet — not even the user's own message, which the runner paints from
 * `session_start` once it claims the run.
 *
 * The workspace still knows the prompt (the session's meta, `sessionPrompt`),
 * so the conversation shows what was asked from the start, and says that it
 * is waiting rather than that an agent is working.
 */
import type { ChatNode, SessionStatus } from './session-store';

/** The key of the stand-in bubble; the runner's own bubble replaces it on claim. */
export const QUEUED_OPENING_KEY = 'queued-opening';

/**
 * The user's request, shown while the session waits to be claimed and the
 * transcript has no message of its own yet. Null otherwise: a follow-up that
 * requeued an idle conversation is already on the transcript (`user_message`).
 */
export function queuedOpeningMessage(input: {
  readonly status: SessionStatus;
  readonly chat: readonly ChatNode[];
  readonly prompt: string | null | undefined;
}): ChatNode | null {
  if (input.status !== 'queued') return null;
  const text = input.prompt?.trim();
  if (!text) return null;
  if (input.chat.some((node) => node.kind === 'user')) return null;
  return { key: QUEUED_OPENING_KEY, kind: 'user', text };
}
