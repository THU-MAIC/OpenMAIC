/**
 * What a conversation is called.
 *
 * Two facts and one rule. The facts: `title`, the name the user gave it (an
 * override, stored on the session row), and `prompt`, the first message. The
 * rule: the override wins, otherwise the title is derived from what was asked —
 * a conversation is named by its own question, never by whatever course happens
 * to be open beside it.
 *
 * Pure, and shared, because the pane header and the rail row must never
 * disagree about what a chat is called: two derivations is how a rename appears
 * in one place and not the other.
 */

/** The longest name a conversation may be given. Mirrors the server's cap. */
export const SESSION_TITLE_MAX_LENGTH = 120;

export interface WorkbenchSessionNaming {
  /** The stored override, if the user named this conversation. */
  readonly title?: string | null;
  /** The first message. */
  readonly prompt?: string | null;
}

/**
 * The title, or `null` when there is nothing to derive one from yet (an empty
 * conversation). Callers supply their own placeholder for that case — the rail
 * says "Untitled chat", the pane header says "New chat" — because they are
 * answering different questions about the same absent name.
 */
export function workbenchSessionTitle(session: WorkbenchSessionNaming): string | null {
  return session.title?.trim() || session.prompt?.trim() || null;
}

/**
 * Is this what the title would be anyway? Submitting the derived title verbatim
 * is not a rename, and storing it would freeze a name the user never chose —
 * the next edit of the first message (or a fixed derivation) could no longer
 * reach it. Treated as a clear instead.
 */
export function isDerivedSessionTitle(session: WorkbenchSessionNaming, next: string): boolean {
  return next.trim() === (session.prompt?.trim() ?? '');
}

/**
 * The name a rename should send: the trimmed text, capped, or `null` to clear
 * the override (an empty box, or the derived title typed back in).
 */
export function normalizeSessionTitleInput(
  session: WorkbenchSessionNaming,
  raw: string,
): string | null {
  const next = raw.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!next) return null;
  return isDerivedSessionTitle(session, next) ? null : next;
}

export type SessionRenameOutcome = 'unchanged' | 'renamed' | 'failed';

/**
 * One rename, start to finish: write it everywhere it shows immediately, settle
 * on what the server actually stored, and put the old name back if the write is
 * refused.
 *
 * Here rather than in the component so the sequence — and especially the
 * rollback, the part nobody exercises by hand — is testable without a DOM. The
 * caller supplies `apply` (the surfaces showing this chat's name) and `save`
 * (the PATCH), which is what keeps the whole feature to a single writer.
 */
export async function commitSessionRename({
  current,
  raw,
  apply,
  save,
}: {
  readonly current: WorkbenchSessionNaming;
  readonly raw: string;
  readonly apply: (title: string | null) => void;
  /** Resolves to the title the server stored — it caps the length. */
  readonly save: (title: string | null) => Promise<string | null>;
}): Promise<SessionRenameOutcome> {
  const next = normalizeSessionTitleInput(current, raw);
  const previous = current.title?.trim() || null;
  // Unchanged is not a rename; do not spend a round trip saying so.
  if (next === previous) return 'unchanged';
  apply(next);
  try {
    apply(await save(next));
    return 'renamed';
  } catch {
    apply(previous);
    return 'failed';
  }
}
