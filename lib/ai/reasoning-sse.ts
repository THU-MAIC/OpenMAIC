import type { LanguageModelMiddleware } from 'ai';

/**
 * Reasoning-channel normalization for OpenAI-compatible providers.
 *
 * DeepSeek-style models stream their chain-of-thought in a separate
 * `delta.reasoning_content` field. `@ai-sdk/openai`
 * speaks the standard chat-completions schema, whose delta has no such field, so
 * it silently DROPS reasoning — it never reaches the agent stream or the UI.
 *
 * To recover it without a bespoke provider, we rewrite the wire so reasoning
 * arrives inline as a `<think>…</think>` block in `content`. The model instance is
 * then wrapped with the AI SDK's `extractReasoningMiddleware({ tagName: 'think' })`,
 * which splits that block back out into first-class `reasoning` stream parts while
 * leaving the answer text clean. (This also subsumes models that already emit
 * inline `<think>` natively, e.g. MiniMax-M3.)
 *
 * The rewriter is a small state machine over the streamed chunks: it opens the
 * tag on the first reasoning delta and closes it at the first non-reasoning
 * signal (real content, a tool call, or finish) — including the case where
 * reasoning is followed directly by a tool call with no content in between.
 */

interface ChatChunkLike {
  choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
}

const KIMI_REASONING_MARKER = '\u0000openmaic:kimi-reasoning:';

function encodeKimiReasoning(text: string): string {
  return `${KIMI_REASONING_MARKER}${text.length}:${text}`;
}

function extractKimiReasoning(content: string): { content: string; reasoning?: string } {
  let remaining = content;
  let reasoning = '';

  for (;;) {
    const markerIndex = remaining.indexOf(KIMI_REASONING_MARKER);
    if (markerIndex < 0) break;

    const lengthStart = markerIndex + KIMI_REASONING_MARKER.length;
    const separatorIndex = remaining.indexOf(':', lengthStart);
    if (separatorIndex < 0) break;

    const lengthText = remaining.slice(lengthStart, separatorIndex);
    if (!/^\d+$/.test(lengthText)) break;

    const reasoningLength = Number(lengthText);
    const reasoningStart = separatorIndex + 1;
    const reasoningEnd = reasoningStart + reasoningLength;
    if (reasoningEnd > remaining.length) break;

    reasoning += remaining.slice(reasoningStart, reasoningEnd);
    remaining = remaining.slice(0, markerIndex) + remaining.slice(reasoningEnd);
  }

  return reasoning ? { content: remaining, reasoning } : { content };
}

/**
 * The OpenAI chat adapter drops standardized reasoning prompt parts. Encode
 * them as private text markers until the request reaches our fetch wrapper,
 * where they are restored to Kimi's `reasoning_content` field.
 */
export function createKimiReasoningPreservationMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({
      ...params,
      prompt: params.prompt.map((message) =>
        message.role !== 'assistant'
          ? message
          : {
              ...message,
              content: message.content.map((part) =>
                part.type === 'reasoning'
                  ? { type: 'text' as const, text: encodeKimiReasoning(part.text) }
                  : part,
              ),
            },
      ),
    }),
  };
}

/** Restore private Kimi reasoning markers after OpenAI chat serialization. */
export function restoreKimiReasoningInRequestBody(body: unknown): void {
  if (!body || typeof body !== 'object') return;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return;

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.role !== 'assistant' || typeof record.content !== 'string') continue;

    const restored = extractKimiReasoning(record.content);
    if (!restored.reasoning) continue;

    record.reasoning_content = restored.reasoning;
    record.content =
      restored.content === '' && Array.isArray(record.tool_calls) ? null : restored.content;
  }
}

/**
 * Create a stateful rewriter for one streamed response. Call it on each parsed
 * `chat.completion.chunk`; it mutates and returns the same object with
 * `reasoning_content` folded into a `<think>…</think>` block in `content`.
 */
export function createReasoningContentRewriter() {
  let open = false; // a <think> tag has been emitted
  let closed = false; // a matching </think> has been emitted

  return function rewrite<T extends ChatChunkLike>(chunk: T): T {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (!delta) return chunk;

    const rc = delta.reasoning_content;
    const reasoning = typeof rc === 'string' ? rc : '';

    if (reasoning !== '' && !closed) {
      // Reasoning delta: open the block on the first one (prefix `<think>`), then
      // append raw. If the SAME chunk also carries real answer `content`, close
      // the block BEFORE it so the answer isn't absorbed into the reasoning
      // (some providers send the reasoning→answer transition in one delta).
      const origContent = typeof delta.content === 'string' ? delta.content : '';
      const prefix = open ? '' : '<think>';
      open = true;
      if (origContent !== '') {
        delta.content = prefix + reasoning + '</think>' + origContent;
        closed = true;
      } else {
        delta.content = prefix + reasoning;
      }
      delete delta.reasoning_content;
      return chunk;
    }

    if ('reasoning_content' in delta) delete delta.reasoning_content;

    if (open && !closed) {
      const hasContent = typeof delta.content === 'string' && delta.content !== '';
      const hasToolCall = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
      const finishing = choice?.finish_reason != null;
      if (hasContent || hasToolCall || finishing) {
        delta.content = '</think>' + (typeof delta.content === 'string' ? delta.content : '');
        closed = true;
      }
    }

    return chunk;
  };
}

/**
 * Wrap a streaming chat-completions `Response` so each SSE `data:` chunk passes
 * through {@link createReasoningContentRewriter}. Non-data lines (comments,
 * `[DONE]`, blank separators) and unparseable payloads pass through verbatim.
 * Buffers across read boundaries so a `data:` line split mid-JSON is handled.
 */
export function wrapResponseWithReasoning(response: Response): Response {
  if (!response.body) return response;
  const rewrite = createReasoningContentRewriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    try {
      const obj = rewrite(JSON.parse(payload) as Record<string, unknown>);
      return 'data: ' + JSON.stringify(obj);
    } catch {
      return line; // keep-alive / non-JSON / partial — leave as-is
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // last (possibly partial) line stays buffered
      for (const line of lines) controller.enqueue(encoder.encode(rewriteLine(line) + '\n'));
    },
    flush(controller) {
      if (buffer) controller.enqueue(encoder.encode(rewriteLine(buffer)));
    },
  });

  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Recover non-streaming `message.reasoning_content` for the same middleware. */
export async function wrapJsonResponseWithReasoning(response: Response): Promise<Response> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  if (!body || typeof body !== 'object') return response;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return response;

  let changed = false;
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const message = (choice as { message?: unknown }).message;
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (typeof record.reasoning_content !== 'string' || record.reasoning_content === '') continue;

    const content = typeof record.content === 'string' ? record.content : '';
    record.content = `<think>${record.reasoning_content}</think>${content}`;
    delete record.reasoning_content;
    changed = true;
  }

  if (!changed) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
