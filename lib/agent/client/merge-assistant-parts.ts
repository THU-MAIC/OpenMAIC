/**
 * Chronological assembly of the assistant message from pi agent turns.
 *
 * A run produces multiple assistant turns (the tool-call turn, then a wrap-up
 * turn). Each turn's content array is already ordered (text / toolCall parts
 * interleaved as generated), and the runtime replaces a turn's array wholesale
 * on every stream update. Flattening the turns in arrival order makes the
 * rendered sequence match what actually happened: turn-1 text → tool call →
 * wrap-up text BELOW the tool card (never above it). Tool results attach by
 * toolCallId. Pure and side-effect-free so it can be unit-tested without React.
 */

export type PiPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };

export type AssistantPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
    };

export interface MergeInput {
  /** Chronological assistant turns; each is that turn's ordered content. */
  turns: PiPart[][];
  /** Executed tool results keyed by toolCallId. */
  toolResults: Map<string, { result: unknown; isError: boolean }>;
  /** Run-level error (stream failure / turn errorMessage); appended as text. */
  error: string;
}

export function mergeAssistantParts({ turns, toolResults, error }: MergeInput): AssistantPart[] {
  const parts: AssistantPart[] = [];

  for (const turn of turns) {
    for (const p of turn) {
      if (p.type === 'text') {
        if (p.text) parts.push({ type: 'text', text: p.text });
      } else if (p.type === 'reasoning') {
        // Reasoning/thinking renders as assistant-ui's `reasoning` part (a
        // collapsible panel), kept separate from the answer text. Empty drops.
        if (p.text) parts.push({ type: 'reasoning', text: p.text });
      } else {
        const r = toolResults.get(p.id);
        parts.push({
          type: 'tool-call',
          toolCallId: p.id,
          toolName: p.name,
          args: p.arguments,
          ...(r ? { result: r.result, isError: r.isError } : {}),
        });
      }
    }
  }

  if (error) parts.push({ type: 'text', text: error });
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return parts;
}
