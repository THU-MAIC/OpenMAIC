/**
 * Pure status derivation for the `edit_interactive_html` tool card — extracted
 * from the tool-UI render so it can be unit-tested without React.
 *
 * The authoritative success signal is the tool's OWN result: `details.html` is a
 * string when the str_replace edits applied (the client then writes it to the
 * scene). A successful apply must never render as "failed" — not even when the
 * assistant message ends with status `incomplete`, which a reasoning model can
 * trigger (it streams reasoning, calls the tool, then the wrap-up turn leaves the
 * message `incomplete` even though the edit already landed).
 */

export interface EditInteractiveHtmlResult {
  content?: { type: string; text?: string }[];
  details?: { sceneId?: string; html?: string | null; editCount?: number };
}

/** True when the edits applied (the tool returned a concrete HTML string). */
export function isEditApplied(result?: EditInteractiveHtmlResult | null): boolean {
  return typeof result?.details?.html === 'string';
}

/** True only when the tool explicitly refused / could not apply (html === null). */
export function isEditRefused(result?: EditInteractiveHtmlResult | null): boolean {
  const d = result?.details;
  return !!d && 'html' in d && d.html === null;
}

/**
 * Whether the edit-tool card should show its "failed" (not-fixed) state.
 *
 * Bias to success: a card only fails on an EXPLICIT failure signal — an
 * `isError` result, or a result whose html came back `null` (refusal /
 * unappliable edit). A successful apply, a missing/unpropagated result, or an
 * `incomplete` message status are NOT failures — pi-agent-core's result
 * propagation is lossy and the slim persisted result drops the html payload, so
 * treating "no positive signal" as failure wrongly showed ✕ on edits that
 * actually applied. `running` and `stopped` are their own states.
 */
export function deriveEditFailed(args: {
  running: boolean;
  stopped: boolean;
  isError: boolean;
  result?: EditInteractiveHtmlResult | null;
}): boolean {
  const { running, stopped, isError, result } = args;
  if (running || stopped) return false;
  if (isEditApplied(result)) return false;
  return isError || isEditRefused(result);
}
