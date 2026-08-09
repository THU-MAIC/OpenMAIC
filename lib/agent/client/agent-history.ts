/**
 * Project thread messages into text-only history for the agent edit API.
 * Includes edit_elements apply outcomes so a refused client apply is visible
 * to the model on the next turn (tool-call parts are otherwise dropped).
 */
import {
  editElementsOutcome,
  editElementsRefuseReason,
} from '@/lib/agent/client/edit-elements-result';

export type HistoryTurn = { role: 'user' | 'assistant'; text: string };

type ContentPart = {
  type?: string;
  text?: string;
  toolName?: string;
  result?: {
    content?: { type?: string; text?: string }[];
    details?: {
      intents?: unknown[] | null;
      updateCount?: number;
      refuseReason?: string;
    };
  };
  isError?: boolean;
};

function editElementsOutcomeLine(part: ContentPart): string | null {
  if (part.type !== 'tool-call' || part.toolName !== 'edit_elements') return null;
  const details = part.result?.details;
  const outcome = editElementsOutcome(details);
  if (outcome === 'refused') {
    const reason = editElementsRefuseReason(part.result) ?? 'refused';
    return `[edit_elements: not applied — ${reason}]`;
  }
  if (outcome === 'applied' && !part.isError) {
    const intents = details?.intents;
    if (!Array.isArray(intents)) return null;
    const n = typeof details?.updateCount === 'number' ? details.updateCount : intents.length;
    return `[edit_elements: applied ${n} update(s)]`;
  }
  if (part.isError) {
    return `[edit_elements: not applied]`;
  }
  return null;
}

/** Flatten one message's content into history text (incl. edit_elements outcomes). */
export function messageTextForHistory(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const raw of content) {
    const p = raw as ContentPart;
    if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      chunks.push(p.text.trim());
    }
    const outcome = editElementsOutcomeLine(p);
    if (outcome) chunks.push(outcome);
  }
  return chunks.join('\n').trim();
}

export function toAgentHistory(
  messages: Array<{ role?: string; content?: unknown }>,
): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const m of messages) {
    const text = messageTextForHistory(m.content);
    if (!text) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', text });
  }
  return out;
}
