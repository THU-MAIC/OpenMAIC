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

/**
 * Normalize one stored title override at the shared client/server boundary.
 *
 * HTML's `maxLength` and JavaScript's `slice` both count UTF-16 code units, so
 * that remains the budget here. The `Array.from` pass replaces NUL and lone
 * surrogates, which PostgreSQL TEXT / JSONB cannot store, without requiring a
 * newer browser built-in; the final guard prevents the cap itself from cutting
 * a valid surrogate pair in half.
 */
export function normalizeSessionTitleOverride(value: string | null): string | null {
  if (value === null) return null;
  const wellFormed = Array.from(value.trim(), (character) => {
    const codeUnit = character.charCodeAt(0);
    const unstorable =
      codeUnit === 0 || (character.length === 1 && codeUnit >= 0xd800 && codeUnit <= 0xdfff);
    return unstorable ? '\ufffd' : character;
  }).join('');
  const truncated = wellFormed.slice(0, SESSION_TITLE_MAX_LENGTH);
  if (!truncated) return null;
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) || null : truncated;
}

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
  const next = normalizeSessionTitleOverride(raw);
  if (!next) return null;
  return isDerivedSessionTitle(session, next) ? null : next;
}

export type SessionRenameOutcome = 'unchanged' | 'renamed' | 'failed';

/**
 * Keep saves for one conversation in submit order while leaving unrelated
 * conversations independent. Each tail is settled even when its task fails,
 * so one refused rename never poisons the next turn.
 */
export function createSessionRenameQueue(): {
  run<T>(sessionId: string, task: (queued: boolean) => Promise<T>): Promise<T>;
} {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(sessionId: string, task: (queued: boolean) => Promise<T>): Promise<T> {
      const predecessor = tails.get(sessionId);
      const queued = predecessor !== undefined;
      const run = (predecessor ?? Promise.resolve()).then(() => task(queued));
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(sessionId, tail);
      void tail.then(() => {
        if (tails.get(sessionId) === tail) tails.delete(sessionId);
      });
      return run;
    },
  };
}

/**
 * One rename, start to finish: write it everywhere it shows immediately, settle
 * on what the server actually stored, and put the old name back if the write is
 * refused.
 *
 * Here rather than in the component so the sequence — and especially the
 * rollback, the part nobody exercises by hand — is testable without a DOM. The
 * caller supplies `apply` (the surfaces showing this chat's name, plus whether
 * the PATCH has settled) and `save` (the PATCH), which is what keeps the whole
 * feature to a single writer.
 */
export async function commitSessionRename({
  current,
  raw,
  apply,
  save,
  isCurrent = () => true,
  forceSave = false,
}: {
  readonly current: WorkbenchSessionNaming;
  readonly raw: string;
  readonly apply: (title: string | null, settled: boolean) => void;
  /** Resolves to the title the server stored — it caps the length. */
  readonly save: (title: string | null) => Promise<string | null>;
  /** False when another authoritative title decision arrived while PATCH was pending. */
  readonly isCurrent?: () => boolean;
  /** Preserve an explicit decision queued behind a write whose outcome may still be ambiguous. */
  readonly forceSave?: boolean;
}): Promise<SessionRenameOutcome> {
  const next = normalizeSessionTitleInput(current, raw);
  const previous = current.title?.trim() || null;
  // Unchanged is not a rename; do not spend a round trip saying so.
  if (!forceSave && next === previous) return 'unchanged';
  apply(next, false);
  try {
    const stored = await save(next);
    if (isCurrent()) apply(stored, true);
    return 'renamed';
  } catch {
    if (isCurrent()) apply(previous, true);
    return 'failed';
  }
}
