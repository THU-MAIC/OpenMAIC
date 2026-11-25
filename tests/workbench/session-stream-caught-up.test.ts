// @vitest-environment jsdom
/**
 * The stream hook's caught-up state machine, driven at the wire level (#2283):
 * a real `FetchEventSource` against a fetch the test scripts frame by frame.
 * The question is what the fold holds, and when — before `caught_up` every
 * frame (live-labelled or not) waits in the client's backlog; a reconnect
 * replays the gap as backlog-labelled frames the client applies at once
 * (that is the design: they are history the user never saw arrive); the
 * watchdog flushes a stream that went silent mid-replay.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';
import {
  createInitialSessionState,
  useWorkbenchStore,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
import { useQuestionAutoConfirm } from '@/lib/workbench/question-auto-confirm';
import { sessionScopedKey } from '@/lib/workbench/request-scope';

interface Wire {
  /** The fetch the connection was opened with: its headers carry `last-event-id` on a reconnect. */
  readonly headers: Record<string, string>;
  readonly send: (text: string) => void;
  readonly drop: () => void;
}

let wires: Wire[];
let fetchMock: ReturnType<typeof vi.fn>;

/** Each fetch for the events route answers with a stream the test writes to. */
function answerEventsWithStreams() {
  fetchMock.mockImplementation(async (url: string | unknown, init?: RequestInit) => {
    const target = String(url ?? '');
    if (!target.includes('/events')) {
      // The attachment's meta read: nothing to add.
      return new Response('{}', { status: 404 });
    }
    let dropped = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        wires.push({
          headers: (init?.headers ?? {}) as Record<string, string>,
          send: (text) => controller.enqueue(new TextEncoder().encode(text)),
          drop: () => {
            if (dropped) return;
            dropped = true;
            controller.error(new Error('dropped'));
          },
        });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

const sse = (event: WorkbenchEvent & { phase?: string }) =>
  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const CAUGHT_UP = `event: caught_up\ndata: ${JSON.stringify({ type: 'caught_up' })}\n\n`;

const event = (
  id: number,
  ts: number,
  type: string,
  data: Record<string, unknown>,
  phase: 'live' | 'backlog',
): WorkbenchEvent & { phase: string } => ({ id, ts, attempt: 1, type, data, phase });

const RUN_START = (phase: 'live' | 'backlog') =>
  event(1, 30_000, 'session_start', { prompt: 'Make a course' }, phase);
const QUESTION = (phase: 'live' | 'backlog') =>
  event(4, 31_200, 'user_question', { question: 'Build this plan?' }, phase);

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('location', { href: 'https://app.example/page' });
  wires = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  answerEventsWithStreams();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useWorkbenchStore.setState(createInitialSessionState() as never);
  useQuestionAutoConfirm.setState({ live: [], stopped: [], autoConfirmed: [] });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Attach the stream to a session, as the workspace does. */
async function attachStream(sessionId: string) {
  await act(async () => {
    useWorkbenchStore.setState({
      ...createInitialSessionState(),
      sessionId,
      status: 'connecting',
      replaying: true,
    } as never);
  });
  await act(async () => {
    root.render(createElement(Host, { sessionId }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
}

function Host({ sessionId }: { sessionId: string }) {
  useWorkbenchStream(sessionId);
  return null;
}

const foldHasQuestion = () =>
  useWorkbenchStore.getState().chat.some((node) => node.kind === 'question');
const questionLiveMarked = (sessionId: string) =>
  useQuestionAutoConfirm.getState().live.includes(sessionScopedKey(sessionId, 'e4'));

describe('a question on the live tail', () => {
  it('folds the moment the frame arrives, and is marked live for auto-confirm', async () => {
    await attachStream('s1');
    wires[0]!.send(CAUGHT_UP);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    wires[0]!.send(sse(RUN_START('live')));
    wires[0]!.send(sse(QUESTION('live')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(foldHasQuestion()).toBe(true);
    expect(questionLiveMarked('s1')).toBe(true);
    expect(useWorkbenchStore.getState().replaying).toBe(false);
  });
});

describe('a question that lands before caught_up', () => {
  it('waits in the client backlog — even a live-labelled frame — until the watchdog flushes', async () => {
    await attachStream('s1');
    // The server has drained (it labels live) but the `caught_up` event is
    // still in flight: the client buffers, and the stream then goes quiet.
    wires[0]!.send(sse(RUN_START('live')));
    wires[0]!.send(sse(QUESTION('live')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(foldHasQuestion()).toBe(false);
    // REPLAY_WATCHDOG_MS of silence ends the wait.
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(foldHasQuestion()).toBe(true);
  });
});

describe('a question replayed over a reconnect', () => {
  it('applies at once (the client was caught up), and is history, not live', async () => {
    await attachStream('s1');
    wires[0]!.send(CAUGHT_UP);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    wires[0]!.send(sse(RUN_START('live')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    // The connection drops; EventSource reconnects with the last event id
    // (its default retry is 3 s).
    wires[0]!.drop();
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(wires.length).toBe(2);
    expect(wires[1]!.headers['last-event-id']).toBe('1');
    // The gap replays as backlog-labelled frames; the client applies them
    // directly — its catch-up state survived the reconnect.
    wires[1]!.send(sse(QUESTION('backlog')));
    wires[1]!.send(CAUGHT_UP);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(foldHasQuestion()).toBe(true);
    expect(questionLiveMarked('s1')).toBe(false);
  });
});

describe('a watchdog that fired mid-replay', () => {
  it('lets the frames still labelled backlog apply live afterwards', async () => {
    await attachStream('s1');
    // A frame, then silence: the watchdog flushes the one-frame backlog.
    wires[0]!.send(sse(RUN_START('backlog')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(useWorkbenchStore.getState().replaying).toBe(false);
    // The server is still draining: the frames it sends now carry the
    // backlog label, but this client is caught up and folds them at once.
    wires[0]!.send(sse(QUESTION('backlog')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(foldHasQuestion()).toBe(true);
    // The server's word decides auto-confirm: backlog-labelled is history.
    expect(questionLiveMarked('s1')).toBe(false);
  });
});
