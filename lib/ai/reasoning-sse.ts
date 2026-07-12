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
