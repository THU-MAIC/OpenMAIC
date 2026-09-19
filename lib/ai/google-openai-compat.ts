/**
 * Gemini OpenAI-compatible endpoint shim.
 *
 * Measured with `OPENAI_BASE_URL` = Google's OpenAI-compatible endpoint and
 * `openai:gemini-3.8-flash` (openai-completions) as the workbench agent driver:
 * plain chat works, but every tool call fails with
 *   Type validation failed … choices[0].delta.tool_calls[0].index:
 *   expected number, received undefined
 * Google's streamed tool_call deltas omit the `index` the OpenAI stream
 * contract requires (`@ai-sdk/openai` chat chunk schema: `index: z.number()`),
 * and carry `extra_content.google.thought_signature`, which Gemini 3 expects
 * back on the assistant message's tool call in the next request.
 *
 * Two functions, wired into `lib/ai/providers.ts`'s compatibility fetch,
 * only when the base URL host is Google's:
 *  - response: add `index` to streamed tool_call deltas (per tool-call id,
 *    assigned in order of first appearance) and remember thought signatures;
 *  - request: put the remembered signature back on assistant tool_calls.
 */

const GOOGLE_HOST = 'generativelanguage.googleapis.com';
const MAX_REMEMBERED_SIGNATURES = 1_000;

const signatures = new Map<string, string>();

function remember(id: string, signature: string): void {
  if (!signatures.has(id) && signatures.size >= MAX_REMEMBERED_SIGNATURES) {
    const oldest = signatures.keys().next().value;
    if (oldest !== undefined) signatures.delete(oldest);
  }
  signatures.set(id, signature);
}

/** Is this the Gemini OpenAI-compatible endpoint? */
export function isGoogleOpenAICompatUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === GOOGLE_HOST;
  } catch {
    return url.includes(GOOGLE_HOST);
  }
}

interface ToolCallDelta {
  index?: unknown;
  id?: unknown;
  extra_content?: { google?: { thought_signature?: unknown } };
  [key: string]: unknown;
}

/**
 * Rewrite one parsed SSE chunk in place: give every streamed tool_call delta an
 * `index` (stable per tool-call id) and remember Google's thought signature.
 * Returns the same object for convenience.
 */
export function normalizeGoogleChunk(
  chunk: Record<string, unknown>,
  indexById: Map<string, number>,
): Record<string, unknown> {
  const choices = chunk.choices;
  if (!Array.isArray(choices)) return chunk;
  for (const choice of choices as Array<{ delta?: { tool_calls?: unknown } }>) {
    const toolCalls = choice?.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    toolCalls.forEach((call: ToolCallDelta, position: number) => {
      if (!call || typeof call !== 'object') return;
      const id = typeof call.id === 'string' ? call.id : undefined;
      if (typeof call.index !== 'number') {
        if (id !== undefined) {
          if (!indexById.has(id)) indexById.set(id, indexById.size);
          call.index = indexById.get(id);
        } else {
          call.index = position;
        }
      }
      const signature = call.extra_content?.google?.thought_signature;
      if (id !== undefined && typeof signature === 'string') remember(id, signature);
    });
  }
  return chunk;
}

/** Wrap a streaming response so every `data:` chunk passes through `normalizeGoogleChunk`. */
export function normalizeGoogleToolCallStream(response: Response): Response {
  if (!response.body) return response;
  const indexById = new Map<string, number>();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const rewriteLine = (line: string): string => {
    if (!line.startsWith('data:')) return line;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') return line;
    try {
      return 'data: ' + JSON.stringify(normalizeGoogleChunk(JSON.parse(payload), indexById));
    } catch {
      return line;
    }
  };
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
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

/**
 * Put remembered thought signatures back on assistant tool_calls in an
 * OpenAI-shaped request body. Returns the (possibly rewritten) init.
 */
export function restoreGoogleThoughtSignatures(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (!init?.body || typeof init.body !== 'string' || signatures.size === 0) return init;
  let body: { messages?: unknown };
  try {
    body = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (!Array.isArray(body.messages)) return init;
  let changed = false;
  for (const message of body.messages as Array<{ role?: unknown; tool_calls?: unknown }>) {
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as ToolCallDelta[]) {
      const id = typeof call?.id === 'string' ? call.id : undefined;
      if (id === undefined || call.extra_content?.google?.thought_signature) continue;
      const signature = signatures.get(id);
      if (signature === undefined) continue;
      call.extra_content = {
        ...(call.extra_content ?? {}),
        google: {
          ...(call.extra_content?.google ?? {}),
          thought_signature: signature,
        },
      };
      changed = true;
    }
  }
  return changed ? { ...init, body: JSON.stringify(body) } : init;
}

/** Test hook. */
export function forgetGoogleThoughtSignatures(): void {
  signatures.clear();
}
