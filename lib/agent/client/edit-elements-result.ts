export interface EditElementsResultDetails {
  intents?: unknown[] | null;
  refuseReason?: string;
}

export interface EditElementsResultLike {
  content?: { type?: string; text?: string }[];
  details?: EditElementsResultDetails;
}

export type EditElementsOutcome = 'applied' | 'refused' | 'pending';

export interface EditElementsRunOutcome {
  applied: boolean;
  failed: boolean;
}

export function editElementsApplyCorrectionKey(
  outcome: EditElementsRunOutcome,
): 'edit.editElements.applyFailed' | 'edit.editElements.applyPartiallyFailed' | null {
  if (!outcome.failed) return null;
  return outcome.applied
    ? 'edit.editElements.applyPartiallyFailed'
    : 'edit.editElements.applyFailed';
}

/** Interpret the structured edit_elements result marker in one place. */
export function editElementsOutcome(
  details: EditElementsResultDetails | null | undefined,
): EditElementsOutcome {
  if (Array.isArray(details?.intents) && details.intents.length > 0) return 'applied';
  if (details && 'intents' in details && details.intents === null) return 'refused';
  return 'pending';
}

/**
 * Read a refusal reason from structured details, with compatibility for
 * persisted threads created before refuseReason was added.
 */
export function editElementsRefuseReason(
  result: EditElementsResultLike | null | undefined,
): string | undefined {
  const structured = result?.details?.refuseReason;
  if (typeof structured === 'string' && structured.trim()) return structured.trim();

  const text = result?.content?.find((part) => part.type === 'text' && part.text)?.text;
  if (!text) return undefined;
  const match = text.match(/Could not apply the edit:\s*(.+?)(?:\.\s*Nothing was changed\.?)?$/i);
  return match?.[1]?.trim();
}
