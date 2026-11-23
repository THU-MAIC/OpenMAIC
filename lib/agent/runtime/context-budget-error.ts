/**
 * Local context admission failure: the request would exceed the model's
 * context budget even after compaction, so it is never sent. This is not a
 * provider outage or a credential error, and retrying the same transcript
 * cannot succeed.
 */
export type ContextBudgetReason =
  | 'summary_failed'
  | 'still_oversized'
  | 'invalid_output_budget'
  | 'no_compaction_boundary';

/** Stable code carried on the terminal `session_end` frame. */
export const CONTEXT_BUDGET_EXCEEDED = 'CONTEXT_BUDGET_EXCEEDED';

export class ContextBudgetError extends Error {
  constructor(public readonly reason: ContextBudgetReason) {
    super(`${CONTEXT_BUDGET_EXCEEDED}:${reason}`);
    this.name = 'ContextBudgetError';
  }
}

const CONTEXT_BUDGET_MESSAGE =
  /^CONTEXT_BUDGET_EXCEEDED:(summary_failed|still_oversized|invalid_output_budget|no_compaction_boundary)$/;

/**
 * Recover the reason from the error string. Pi reduces a thrown context
 * transform to its message, so the string is the transport that survives the
 * agent loop and durable replay.
 */
export function contextBudgetReason(error: unknown): ContextBudgetReason | undefined {
  if (typeof error !== 'string') return undefined;
  return CONTEXT_BUDGET_MESSAGE.exec(error.trim())?.[1] as ContextBudgetReason | undefined;
}

/** Workbench copy for a context-budget failure; undefined for any other error. */
export function contextBudgetCopyKey(error: string): `workbench.${string}` | undefined {
  const reason = contextBudgetReason(error);
  if (!reason) return undefined;
  switch (reason) {
    case 'summary_failed':
      return 'workbench.system.contextSummaryFailed';
    case 'still_oversized':
      return 'workbench.system.contextStillTooLarge';
    case 'no_compaction_boundary':
      return 'workbench.system.contextNoBoundary';
    case 'invalid_output_budget':
      return 'workbench.system.contextBudgetInvalid';
  }
}

/**
 * The "what you can do" clause for the same failure. Undefined when the
 * misconfiguration copy needs no user action (an operator fixes it, not the
 * user).
 */
export function contextBudgetHintKey(error: string): `workbench.${string}` | undefined {
  const reason = contextBudgetReason(error);
  if (!reason) return undefined;
  switch (reason) {
    case 'summary_failed':
      // A retry re-runs the summary, which helps when the provider hiccuped.
      // It cannot help when the history itself is too large to summarize
      // (SummaryInputTooLargeError) or the summary route keeps rejecting the
      // call, so the advice names the way out of the conversation too.
      return 'workbench.system.retryOrNewChatHint';
    // Both also fire for one oversized input, not only a long history: with
    // compaction off, or when the latest message is too large for any cut, a
    // new chat with the same input fails the same way. So the advice names
    // shortening the input as well as the new chat.
    case 'still_oversized':
    case 'no_compaction_boundary':
      return 'workbench.system.shortenOrNewChatHint';
    case 'invalid_output_budget':
      return undefined;
  }
}
