/**
 * Pure serialize / deserialize for AgentBar conversation persistence.
 *
 * The rendered thread (`ThreadMessageLike[]`) is projected to a slim, JSON-safe
 * shape that keeps exactly what the cards re-render — text + tool-call metadata —
 * while dropping the heavy result payloads (full slide elements, base64) that
 * would bloat localStorage. Restoring rebuilds `ThreadMessageLike[]` of the same
 * shape the ExternalStore renders today. Pure + side-effect-free so it can be
 * unit-tested without React.
 */
import type { ThreadMessageLike } from '@assistant-ui/react';

export interface SlimToolResult {
  content?: { type: 'text'; text: string }[];
  details?: {
    sceneId?: string;
    /** null = nothing applied (failure); {elements} = length-only placeholder. */
    content?: { elements: unknown[] } | null;
    actions?: { type?: string }[];
  };
}

export type SerializedPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      isError?: boolean;
      result?: SlimToolResult;
    };

export interface SerializedMessage {
  role: 'user' | 'assistant';
  id?: string;
  content: SerializedPart[];
}

type AnyPart = Record<string, unknown>;

function slimResult(result: unknown): SlimToolResult | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as { content?: unknown; details?: unknown };
  const out: SlimToolResult = {};

  if (Array.isArray(r.content)) {
    out.content = r.content
      .filter((c): c is { type: 'text'; text: string } => {
        const p = c as AnyPart;
        return p?.type === 'text' && typeof p.text === 'string';
      })
      .map((c) => ({ type: 'text', text: c.text }));
  }

  if (r.details && typeof r.details === 'object') {
    const d = r.details as { sceneId?: unknown; content?: unknown; actions?: unknown };
    const details: NonNullable<SlimToolResult['details']> = {};
    if (typeof d.sceneId === 'string') details.sceneId = d.sceneId;
    // Preserve null (failure marker); replace a real content with a length-only
    // placeholder so the element-count line survives without the element data.
    if (d.content === null) details.content = null;
    else if (d.content && typeof d.content === 'object') {
      const els = (d.content as { elements?: unknown }).elements;
      details.content = { elements: Array.isArray(els) ? els.map(() => ({})) : [] };
    }
    if (Array.isArray(d.actions)) {
      details.actions = d.actions.map((a) => ({
        type: (a as AnyPart)?.type as string | undefined,
      }));
    }
    out.details = details;
  }

  return out;
}

function serializePart(part: unknown): SerializedPart | null {
  const p = part as AnyPart;
  if (p?.type === 'text' && typeof p.text === 'string') {
    return { type: 'text', text: p.text };
  }
  if (p?.type === 'tool-call' && typeof p.toolCallId === 'string') {
    return {
      type: 'tool-call',
      toolCallId: p.toolCallId as string,
      toolName: (p.toolName as string) ?? 'tool',
      args: (p.args as Record<string, unknown>) ?? {},
      ...(p.isError ? { isError: true } : {}),
      ...(p.result !== undefined ? { result: slimResult(p.result) } : {}),
    };
  }
  return null;
}

export function serializeThread(messages: ThreadMessageLike[]): SerializedMessage[] {
  const out: SerializedMessage[] = [];
  for (const m of messages) {
    const content = Array.isArray(m.content)
      ? (m.content.map(serializePart).filter(Boolean) as SerializedPart[])
      : typeof m.content === 'string'
        ? [{ type: 'text', text: m.content } as SerializedPart]
        : [];
    if (content.length === 0) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', id: m.id, content });
  }
  return out;
}

export function deserializeThread(saved: SerializedMessage[] | undefined): ThreadMessageLike[] {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && Array.isArray(m.content))
    .map((m) => {
      const base = { role: m.role, id: m.id, content: m.content as ThreadMessageLike['content'] };
      // assistant-ui rejects a `status` on user messages ("status is only
      // supported for assistant messages") — only assistant turns carry it.
      return m.role === 'assistant'
        ? { ...base, status: { type: 'complete', reason: 'stop' } as ThreadMessageLike['status'] }
        : base;
    });
}
