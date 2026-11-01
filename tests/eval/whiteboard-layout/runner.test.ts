import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalScenario } from '@/eval/whiteboard-layout/types';
import type { StatelessEvent } from '@/lib/types/chat';

// Offline: HTTP, the store-backed state manager, screenshot capture and VLM
// scoring are replaced; runScenario itself is the real runner function.

const h = vi.hoisted(() => ({
  steps: [] as string[],
  board: [] as Array<{ from: number; action: string }>,
  managers: 0,
  executeAction: null as null | ((managerId: number) => Promise<void>),
  scoreError: false,
}));

vi.mock('@/eval/whiteboard-layout/state-manager', () => ({
  EvalStateManager: class {
    id = h.managers++;
    constructor() {
      h.board = [];
      h.steps.push(`create:${this.id}`);
    }
    getStoreState() {
      return {
        stage: null,
        scenes: [],
        currentSceneId: null,
        mode: 'playback',
        whiteboardOpen: false,
      };
    }
    async executeAction(action: { type: string }) {
      h.steps.push(`action-start:${this.id}`);
      await h.executeAction?.(this.id);
      h.board.push({ from: this.id, action: action.type });
      h.steps.push(`action-end:${this.id}`);
    }
    getWhiteboardElements() {
      return h.board.slice();
    }
    dispose() {
      h.steps.push(`dispose:${this.id}`);
    }
  },
}));

vi.mock('@/eval/whiteboard-layout/capture', () => ({
  initCapture: vi.fn(),
  closeCapture: vi.fn(),
  captureWhiteboard: vi.fn(async (elements: unknown[]) => {
    h.steps.push(`capture:${JSON.stringify(elements)}`);
    return 'offline.png';
  }),
}));

vi.mock('@/eval/whiteboard-layout/scorer', () => ({
  scoreScreenshot: vi.fn(async () => {
    if (h.scoreError) throw new Error('mock scorer failure');
    return { overall: 8, overlap: { score: 8 } };
  }),
}));

const { runScenario } = await import('@/eval/whiteboard-layout/runner');

const config = {
  baseUrl: 'http://offline.invalid',
  chatModel: 'offline:mock',
  scorerModel: 'offline:mock',
  enableThinking: false,
};

const ev = (type: string, data: Record<string, unknown>) => ({ type, data }) as StatelessEvent;
const start = (messageId: string, agentId: string) => ev('agent_start', { messageId, agentId });
const end = (messageId: string, agentId: string) => ev('agent_end', { messageId, agentId });
const text = (messageId: string, content: string) => ev('text_delta', { messageId, content });
const action = (messageId: string, name = 'wb_draw_text') =>
  ev('action', {
    actionId: `a-${messageId}`,
    actionName: name,
    params: {},
    agentId: 'x',
    messageId,
  });
const done = (data: Record<string, unknown> = {}) =>
  ev('done', { totalActions: 0, totalAgents: 1, ...data });
const sse = (events: StatelessEvent[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');

function scenario(id: string, turns: number): EvalScenario {
  return {
    id,
    name: id,
    description: '',
    tags: [],
    initialStoreState: { stage: null, scenes: [], currentSceneId: null },
    config: { agentIds: ['teacher', 'assistant'], sessionType: 'qa' },
    turns: Array.from({ length: turns }, (_, i) => ({
      userMessage: `turn ${i}`,
      checkpoint: true,
    })),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

let fetchMock: ReturnType<typeof vi.fn>;
let runDir: string;

beforeEach(() => {
  h.steps = [];
  h.board = [];
  h.managers = 0;
  h.executeAction = null;
  h.scoreError = false;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  runDir = mkdtempSync(join(tmpdir(), 'wb-runner-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(runDir, { recursive: true, force: true });
});

function respondWith(...bodies: Array<string | (() => Response)>) {
  for (const body of bodies) {
    fetchMock.mockImplementationOnce(async () =>
      typeof body === 'string' ? new Response(body) : body(),
    );
  }
}

describe('whiteboard runner — failed turns settle queued actions first', () => {
  it.each([
    [
      'an SSE error',
      [start('m', 'teacher'), action('m'), ev('error', { message: 'mock stream failure' })],
      'mock stream failure',
    ],
    ['EOF without done', [start('m', 'teacher'), action('m')], 'Stream ended without a done event'],
  ])(
    'waits for a pending action after %s, then fails the scenario',
    async (_name, events, message) => {
      const gate = deferred();
      h.executeAction = (id) => (id === 0 ? gate.promise : Promise.resolve());
      respondWith(sse(events));

      let settled = false;
      const running = runScenario(scenario('failed', 2), 0, runDir, config).finally(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
      expect(h.steps).toEqual(['create:0', 'action-start:0']);

      gate.resolve();
      const result = await running;
      expect(result.error).toContain(message);
      expect(h.steps).toEqual(['create:0', 'action-start:0', 'action-end:0', 'dispose:0']);
      // No screenshot, and the scenario's second turn is never sent.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.checkpoints).toEqual([]);

      // The next scenario starts on a clean board: nothing from scenario 0 lands in it.
      respondWith(sse([start('n', 'teacher'), text('n', 'ok'), end('n', 'teacher'), done()]));
      const next = await runScenario(scenario('next', 1), 0, runDir, config);
      expect(next.error).toBeUndefined();
      expect(h.board).toEqual([]);
      expect(h.steps.slice(4)).toEqual(['create:1', 'capture:[]', 'dispose:1']);
    },
  );

  it('reports the stream failure when a queued action also rejects, without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      h.executeAction = async () => {
        throw new Error('mock action failure');
      };
      // The action rejects while the stream is still open; the error arrives
      // a macrotask later.
      respondWith(
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const encode = (events: StatelessEvent[]) =>
                  controller.enqueue(new TextEncoder().encode(sse(events)));
                encode([start('m', 'teacher'), action('m'), action('m', 'wb_draw_shape')]);
                setTimeout(() => {
                  encode([ev('error', { message: 'mock stream failure' })]);
                  controller.close();
                }, 20);
              },
            }),
          ),
      );

      const result = await runScenario(scenario('both', 1), 0, runDir, config);
      await flush();
      expect(result.error).toContain('mock stream failure');
      expect(result.error).not.toContain('mock action failure');
      expect(unhandled).toEqual([]);
      // The second action is skipped after the first rejects, as before.
      expect(h.steps).toEqual(['create:0', 'action-start:0', 'dispose:0']);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('whiteboard runner — an early exit cancels the request', () => {
  it('aborts the request and cancels the open body on a native whiteboard event', async () => {
    let cancels = 0;
    let body: ReadableStream<Uint8Array> | null = null;
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              sse([ev('whiteboard', { kind: 'projection', stageId: 's', lastSeq: 1 })]),
            ),
          );
          // Left open: the server is still producing.
        },
        cancel() {
          cancels++;
        },
      });
      const response = new Response(stream);
      body = response.body;
      return response;
    });

    const result = await runScenario(scenario('native', 2), 0, runDir, config);

    expect(result.error).toContain('native whiteboard event');
    expect(signal?.aborted).toBe(true);
    expect(cancels).toBe(1);
    expect(body!.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('whiteboard runner — success path', () => {
  it('sends one Pi request per scripted turn and screenshots after actions settle', async () => {
    const gate = deferred();
    h.executeAction = () => gate.promise;
    const directorState = { turnCount: 2, agentResponses: [], whiteboardLedger: [] };
    fetchMock
      .mockImplementationOnce(async () => {
        setTimeout(gate.resolve, 30);
        return new Response(
          sse([
            start('m1', 'teacher'),
            start('m2', 'assistant'),
            text('m1', 'Teacher'),
            text('m2', 'Assistant'),
            action('m1'),
            end('m1', 'teacher'),
            end('m2', 'assistant'),
            done({ sessionClosed: true, endReason: 'lesson_complete', directorState }),
          ]),
        );
      })
      .mockImplementationOnce(
        async () =>
          new Response(
            sse([start('m3', 'teacher'), text('m3', 'Again'), end('m3', 'teacher'), done()]),
          ),
      );

    const result = await runScenario(scenario('ok', 2), 0, runDir, config);

    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([url, init]) => {
      expect(url).toBe('http://offline.invalid/api/chat/pi');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return JSON.parse(init.body as string);
    });
    expect(bodies.every((b) => b.config.piEnableWhiteboardTools === true)).toBe(true);
    expect(bodies[0].directorState).toBeUndefined();
    expect(bodies[1].directorState).toEqual(directorState);
    // Grouped by messageId, sealed per agent; the closed session's next scripted turn is still sent.
    expect(
      bodies[1].messages.map(
        (m: { role: string; content: string; metadata?: { agentId?: string } }) => [
          m.role,
          m.content,
          m.metadata?.agentId,
        ],
      ),
    ).toEqual([
      ['user', 'turn 0', undefined],
      ['assistant', 'Teacher', 'teacher'],
      ['assistant', 'Assistant', 'assistant'],
      ['user', 'turn 1', undefined],
    ]);
    expect(h.steps).toEqual([
      'create:0',
      'action-start:0',
      'action-end:0',
      `capture:${JSON.stringify([{ from: 0, action: 'wb_draw_text' }])}`,
      `capture:${JSON.stringify([{ from: 0, action: 'wb_draw_text' }])}`,
      'dispose:0',
    ]);
    expect(result.checkpoints.map((c) => c.score?.overall)).toEqual([8, 8]);
  });

  it('records a scorer failure as score:null and continues', async () => {
    h.scoreError = true;
    respondWith(sse([done()]), sse([done()]));

    const result = await runScenario(scenario('scorer', 2), 0, runDir, config);

    expect(result.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.checkpoints.map((c) => c.score)).toEqual([null, null]);
  });

  it('fails the scenario on a non-200 response and skips its remaining turns', async () => {
    respondWith(() => new Response('failure', { status: 500 }));

    const result = await runScenario(scenario('http', 2), 0, runDir, config);

    expect(result.error).toContain('API error: 500');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.checkpoints).toEqual([]);
    expect(h.steps).toEqual(['create:0', 'dispose:0']);
  });
});
