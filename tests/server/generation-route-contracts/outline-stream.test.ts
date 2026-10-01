/**
 * Characterization: the raw server-sent event stream of
 * POST /api/generate/scene-outlines-stream — the bytes, the order of the
 * events, the heartbeat comments, the error event, how the stream ends, and
 * what a disconnected client gets. It imports nothing but the route, so it
 * runs unchanged against the route before and after the outline generation
 * moved into lib/server/generation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ streamLLM: vi.fn(), resolveModelFromRequest: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ streamLLM: mocks.streamLLM }));
vi.mock('@/lib/server/resolve-model', () => ({
  resolveModelFromRequest: mocks.resolveModelFromRequest,
}));
vi.mock('@/lib/server/generation-capabilities', () => ({
  resolveServerGenerationCapabilities: async () => ({
    webSearch: false,
    imageGeneration: false,
    videoGeneration: false,
    tts: false,
  }),
}));

const HEAD = '{"languageDirective":"Teach in English.","courseTitle":"Fractions","outlines":[';
const FIRST = '{"id":"o1","type":"slide","title":"Halves","description":"d","keyPoints":["a"]}';
const SECOND = '{"id":"o2","type":"quiz","title":"Check","description":"d","keyPoints":["b"]}';

type Part = { type: string; text?: string; finishReason?: string };

/** A stream that yields `parts`, pausing before the part at each index in `pauses`. */
function modelStream(parts: Part[], pauses: Map<number, Promise<void>> = new Map()) {
  return {
    fullStream: (async function* () {
      for (const [index, part] of parts.entries()) {
        await pauses.get(index);
        yield part;
      }
    })(),
  };
}

const text = (value: string): Part => ({ type: 'text-delta', text: value });
const finish: Part = { type: 'finish', finishReason: 'stop' };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function request(signal?: AbortSignal): NextRequest {
  return new Request('http://localhost/api/generate/scene-outlines-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requirements: { requirement: 'Teach fractions' } }),
    signal,
  }) as unknown as NextRequest;
}

/** Read the body to its end, chunk by chunk, as the bytes arrive. */
async function readAll(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return body;
    body += decoder.decode(value, { stream: true });
  }
}

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const outline = (order: number, fields: Record<string, unknown>) => ({ ...fields, order });

describe('POST /api/generate/scene-outlines-stream event stream', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.streamLLM.mockReset();
    mocks.resolveModelFromRequest.mockReset();
    mocks.resolveModelFromRequest.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
      serverManaged: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('frames each event, keeps the connection alive with heartbeats, and ends with done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const pause = deferred();
    mocks.streamLLM.mockReturnValue(
      modelStream(
        [text(HEAD + FIRST + ','), text(SECOND + ']}'), finish],
        new Map([[1, pause.promise]]),
      ),
    );
    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
    const body = readAll(response);

    // The model is silent for two heartbeat intervals.
    await vi.advanceTimersByTimeAsync(30_000);
    pause.release();

    const first = outline(1, JSON.parse(FIRST));
    const second = outline(2, JSON.parse(SECOND));
    expect(await body).toBe(
      event({ type: 'languageDirective', data: 'Teach in English.' }) +
        event({ type: 'courseTitle', data: 'Fractions' }) +
        event({ type: 'outline', data: first, index: 0 }) +
        ':heartbeat\n\n' +
        ':heartbeat\n\n' +
        event({ type: 'outline', data: second, index: 1 }) +
        event({
          type: 'done',
          outlines: [first, second],
          languageDirective: 'Teach in English.',
          courseTitle: 'Fractions',
          taskEngineMode: false,
        }),
    );
    // The heartbeat stops with the stream.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports each retry and ends with the error event when every attempt is empty', async () => {
    mocks.streamLLM.mockImplementation(() => modelStream([finish]));
    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    expect(await readAll(await POST(request()))).toBe(
      event({ type: 'retry', attempt: 1, maxAttempts: 3 }) +
        event({ type: 'retry', attempt: 2, maxAttempts: 3 }) +
        event({ type: 'error', error: 'LLM returned empty response' }),
    );
    expect(mocks.streamLLM).toHaveBeenCalledTimes(3);
  });

  it('reports a stream error as the error event after the retries', async () => {
    mocks.streamLLM.mockImplementation(() =>
      modelStream([{ type: 'error', error: new Error('invalid key') } as Part, finish]),
    );
    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    expect(await readAll(await POST(request()))).toBe(
      event({ type: 'retry', attempt: 1, maxAttempts: 3 }) +
        event({ type: 'retry', attempt: 2, maxAttempts: 3 }) +
        event({ type: 'error', error: 'invalid key' }),
    );
  });

  it('ends the stream without done or error once the client disconnects', async () => {
    const controller = new AbortController();
    const pause = deferred();
    mocks.streamLLM.mockReturnValue(
      modelStream(
        [text(HEAD + FIRST + ','), text(SECOND + ']}'), finish],
        new Map([[1, pause.promise]]),
      ),
    );
    const { POST } = await import('@/app/api/generate/scene-outlines-stream/route');
    const response = await POST(request(controller.signal));
    const body = readAll(response);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    pause.release();

    expect(await body).toBe(
      event({ type: 'languageDirective', data: 'Teach in English.' }) +
        event({ type: 'courseTitle', data: 'Fractions' }) +
        event({ type: 'outline', data: outline(1, JSON.parse(FIRST)), index: 0 }),
    );
    expect(mocks.streamLLM).toHaveBeenCalledTimes(1);
    expect(mocks.streamLLM.mock.calls[0]![0].abortSignal.aborted).toBe(true);
  });
});
