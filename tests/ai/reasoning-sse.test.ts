import { describe, it, expect } from 'vitest';
import { createReasoningContentRewriter, wrapResponseWithReasoning } from '@/lib/ai/reasoning-sse';

// Build a streaming Response from SSE text, optionally split into arbitrary
// byte-fragments to exercise the line buffer crossing chunk boundaries.
function sseResponse(fragments: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of fragments) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

const dataLine = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;

// A chat.completion.chunk shape (only the bits the rewriter touches).
type Chunk = {
  choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[];
};
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null): Chunk => ({
  choices: [{ delta, finish_reason }],
});
const contentOf = (c: Chunk) => c.choices?.[0]?.delta?.content;
const hasRC = (c: Chunk) => 'reasoning_content' in (c.choices?.[0]?.delta ?? {});

describe('createReasoningContentRewriter', () => {
  it('wraps the first reasoning_content delta with an opening <think> and strips the field', () => {
    const rw = createReasoningContentRewriter();
    const out = rw(chunk({ reasoning_content: 'We ' }));
    expect(contentOf(out)).toBe('<think>We ');
    expect(hasRC(out)).toBe(false);
  });

  it('leaves later reasoning_content deltas unwrapped (tag already open)', () => {
    const rw = createReasoningContentRewriter();
    rw(chunk({ reasoning_content: 'We ' }));
    const out = rw(chunk({ reasoning_content: 'are asked' }));
    expect(contentOf(out)).toBe('are asked');
    expect(hasRC(out)).toBe(false);
  });

  it('closes the block by prepending </think> to the first real content delta', () => {
    const rw = createReasoningContentRewriter();
    rw(chunk({ reasoning_content: 'thinking' }));
    const out = rw(chunk({ content: '391' }));
    expect(contentOf(out)).toBe('</think>391');
  });

  it('does not double-close: subsequent content deltas pass through untouched', () => {
    const rw = createReasoningContentRewriter();
    rw(chunk({ reasoning_content: 'thinking' }));
    rw(chunk({ content: 'The answer ' }));
    const out = rw(chunk({ content: 'is 391' }));
    expect(contentOf(out)).toBe('is 391');
  });

  it('closes the block when reasoning is followed directly by a tool call (no content)', () => {
    const rw = createReasoningContentRewriter();
    rw(chunk({ reasoning_content: 'I should call the tool' }));
    const out = rw(
      chunk({ tool_calls: [{ index: 0, function: { name: 'edit', arguments: '{' } }] }),
    );
    expect(contentOf(out)).toBe('</think>');
    expect(out.choices?.[0]?.delta?.tool_calls).toBeDefined();
  });

  it('closes the block at finish_reason when only reasoning streamed', () => {
    const rw = createReasoningContentRewriter();
    rw(chunk({ reasoning_content: 'done thinking' }));
    const out = rw(chunk({}, 'stop'));
    expect(contentOf(out)).toBe('</think>');
  });

  it('closes the block within a chunk that carries BOTH reasoning_content and content', () => {
    const rw = createReasoningContentRewriter();
    // Some providers send the transition in one delta: reasoning + answer.
    const out = rw(chunk({ reasoning_content: 'I think', content: 'answer' }));
    // The answer must NOT be absorbed into <think>; the block closes before it.
    expect(contentOf(out)).toBe('<think>I think</think>answer');
    expect(hasRC(out)).toBe(false);
  });

  it('passes through a plain (no-reasoning) content stream unchanged', () => {
    const rw = createReasoningContentRewriter();
    const out = rw(chunk({ content: 'hello' }));
    expect(contentOf(out)).toBe('hello');
    expect(hasRC(out)).toBe(false);
  });

  it('is a no-op for chunks without choices', () => {
    const rw = createReasoningContentRewriter();
    const c: Chunk = {};
    expect(() => rw(c)).not.toThrow();
  });
});

describe('wrapResponseWithReasoning', () => {
  it('rewrites reasoning_content into a <think> block across the stream', async () => {
    const res = wrapResponseWithReasoning(
      sseResponse([
        dataLine({ role: 'assistant' }),
        dataLine({ reasoning_content: 'We ' }),
        dataLine({ reasoning_content: 'think' }),
        dataLine({ content: '391' }),
        'data: [DONE]\n\n',
      ]),
    );
    const text = await readAll(res);
    // Reconstruct the content stream the AI SDK will see.
    const contents = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      JSON.parse(`"${m[1]}"`),
    );
    expect(contents.join('')).toBe('<think>We think</think>391');
    expect(text).toContain('data: [DONE]');
    expect(text).not.toContain('reasoning_content');
  });

  it('preserves framing when a data: line is split across read chunks', async () => {
    const line = dataLine({ reasoning_content: 'hello' });
    const mid = Math.floor(line.length / 2);
    const res = wrapResponseWithReasoning(
      sseResponse([
        line.slice(0, mid),
        line.slice(mid),
        dataLine({ content: 'x' }),
        'data: [DONE]\n\n',
      ]),
    );
    const text = await readAll(res);
    const contents = [...text.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      JSON.parse(`"${m[1]}"`),
    );
    expect(contents.join('')).toBe('<think>hello</think>x');
  });

  it('returns the response unchanged when it has no body', () => {
    const res = new Response(null, { status: 204 });
    expect(wrapResponseWithReasoning(res)).toBe(res);
  });
});
