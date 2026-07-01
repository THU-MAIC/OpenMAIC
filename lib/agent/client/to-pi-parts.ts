/**
 * Convert a pi assistant message's content array into the flat `PiPart[]` the
 * runtime accumulates per turn. Pure (no React) so it can be unit-tested.
 *
 * - `thinking` blocks → `reasoning` parts (rendered as a collapsible panel,
 *   separate from the answer text);
 * - `text` blocks → `text` parts, with any inline `<think>…</think>` stripped as
 *   a fallback (some models stream reasoning inline; the provider layer's
 *   extractReasoningMiddleware normally splits it out before it reaches here);
 * - `toolCall` blocks → `toolCall` parts.
 */
import type { PiPart } from './merge-assistant-parts';

export interface PiAssistantContent {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

/**
 * Strip inline reasoning. Closed `<think>…</think>` blocks are removed entirely;
 * an unclosed trailing block (reasoning still streaming) is dropped from its
 * opening tag to the end.
 */
export function stripThinkBlocks(text: string): string {
  let out = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const open = out.search(/<think(?:ing)?>/i);
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/^\s+/, '');
}

export function toPiParts(content: PiAssistantContent[]): PiPart[] {
  const parts: PiPart[] = [];
  for (const c of content) {
    if (c.type === 'text') {
      parts.push({ type: 'text', text: stripThinkBlocks(c.text ?? '') });
    } else if (c.type === 'thinking') {
      parts.push({ type: 'reasoning', text: c.thinking ?? '' });
    } else if (c.type === 'toolCall' && c.id) {
      parts.push({
        type: 'toolCall',
        id: c.id,
        name: c.name ?? 'tool',
        arguments: c.arguments ?? {},
      });
    }
  }
  return parts;
}
