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
import { editElementsOutcome } from '@/lib/agent/client/edit-elements-result';

export interface SlimToolResult {
  content?: { type: 'text'; text: string }[];
  details?: {
    sceneId?: string;
    /** null = nothing applied (failure); {elements} = length-only placeholder. */
    content?: { elements: unknown[] } | null;
    actions?: { type?: string }[];
    /**
     * edit_interactive_html success marker: a non-null string when edits applied
     * (the heavy ~745 KB payload is replaced by a placeholder), `null` on a
     * refusal/unappliable edit. Without this the restored card mistakes a
     * successful edit for a failure. `editCount` survives for the count line.
     */
    html?: string | null;
    editCount?: number;
    /**
     * edit_elements success marker: a non-empty placeholder array when intents
     * applied; `null` on refusal. Drop the heavy props payload — the card only
     * needs applied vs refused.
     */
    intents?: unknown[] | null;
    updateCount?: number;
    /** Gate/host refusal reason retained for agent history and diagnostics. */
    refuseReason?: string;
  };
}

export type SerializedPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; durationMs?: number }
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
    // edit_interactive_html: keep the success/failure signal, drop the payload.
    const dh = (d as { html?: unknown }).html;
    if (dh === null) details.html = null;
    else if (typeof dh === 'string') details.html = dh.length > 0 ? '…' : '';
    const ec = (d as { editCount?: unknown }).editCount;
    if (typeof ec === 'number') details.editCount = ec;
    // edit_elements: keep applied/refused signal, drop intent prop payloads.
    const di = (d as { intents?: unknown }).intents;
    const editOutcome = editElementsOutcome({
      intents: Array.isArray(di) || di === null ? di : undefined,
    });
    if (editOutcome === 'refused') details.intents = null;
    else if (editOutcome === 'applied') details.intents = (di as unknown[]).map(() => ({}));
    const uc = (d as { updateCount?: unknown }).updateCount;
    if (typeof uc === 'number') details.updateCount = uc;
    const rr = (d as { refuseReason?: unknown }).refuseReason;
    if (typeof rr === 'string' && rr.trim()) details.refuseReason = rr.trim();
    if (Array.isArray(d.actions)) {
      details.actions = d.actions.map((a) => ({
        type: (a as AnyPart)?.type as string | undefined,
      }));
    }
    out.details = details;
  }

  return out;
}

function serializePart(part: unknown, durationMs?: number): SerializedPart | null {
  const p = part as AnyPart;
  if (p?.type === 'text' && typeof p.text === 'string') {
    return { type: 'text', text: p.text };
  }
  if (p?.type === 'reasoning' && typeof p.text === 'string') {
    return {
      type: 'reasoning',
      text: p.text as string,
      ...(typeof durationMs === 'number' ? { durationMs } : {}),
    };
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

export function serializeThread(
  messages: ThreadMessageLike[],
  /** Final reasoning durations: (messageId, reasoningOrdinal) → ms. Lets the
   *  restored "已思考 N s" survive a refresh (the live timer store is in-memory). */
  reasoningDurationMs?: (messageId: string | undefined, ordinal: number) => number | undefined,
): SerializedMessage[] {
  const out: SerializedMessage[] = [];
  for (const m of messages) {
    let content: SerializedPart[] = [];
    if (Array.isArray(m.content)) {
      let ord = 0;
      content = m.content
        .map((part) => {
          const isReasoning = (part as AnyPart)?.type === 'reasoning';
          const dur = isReasoning ? reasoningDurationMs?.(m.id, ord++) : undefined;
          return serializePart(part, dur);
        })
        .filter(Boolean) as SerializedPart[];
    } else if (typeof m.content === 'string') {
      content = [{ type: 'text', text: m.content } as SerializedPart];
    }
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
      // Reasoning parts carry our `durationMs` (re-seeded into the timer store on
      // restore, see use-agent-runtime); assistant-ui only accepts {type, text}.
      const content = m.content.map((p) =>
        p.type === 'reasoning' ? { type: 'reasoning', text: p.text } : p,
      ) as ThreadMessageLike['content'];
      const base = { role: m.role, id: m.id, content };
      // assistant-ui rejects a `status` on user messages ("status is only
      // supported for assistant messages") — only assistant turns carry it.
      return m.role === 'assistant'
        ? { ...base, status: { type: 'complete', reason: 'stop' } as ThreadMessageLike['status'] }
        : base;
    });
}
