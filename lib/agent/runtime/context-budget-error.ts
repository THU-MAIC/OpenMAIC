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
  return reason === 'invalid_output_budget'
    ? 'workbench.system.contextBudgetInvalid'
    : 'workbench.system.contextLengthLimit';
}

/**
 * Whether a context-budget failure is final for the conversation: the
 * transcript itself cannot fit even after compaction, so no resend can
 * succeed. Only `still_oversized` and `no_compaction_boundary` are.
 * `summary_failed` means the summary request failed (a provider outage, a
 * timeout), and the next message retries the compaction; `invalid_output_budget`
 * is a model-configuration error, retried once the configuration is fixed.
 */
export function contextBudgetBlocksConversation(error: string): boolean {
  const reason = contextBudgetReason(error);
  return reason === 'still_oversized' || reason === 'no_compaction_boundary';
}
