// @vitest-environment jsdom
/**
 * Which questions may auto-confirm: only one the server delivered as LIVE
 * (`phase: 'live'`). A question replayed on attach, or replayed again after a
 * dropped connection reconnects (the client is already past its first
 * `caught_up` then), is history and never starts a countdown.
 */
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';
import { useQuestionAutoConfirm } from '@/lib/workbench/question-auto-confirm';
import { sessionScopedKey } from '@/lib/workbench/request-scope';

function Harness({ sessionId }: { sessionId: string }) {
  const attach = useWorkbenchStore((state) => state.attach);
  useLayoutEffect(() => {
    attach(sessionId, null);
  }, [attach, sessionId]);
  useWorkbenchStream(sessionId);
  return null;
}

const encoder = new TextEncoder();
const question = (id: number, phase?: 'live' | 'backlog') =>
  `id: ${id}\nevent: user_question\ndata: ${JSON.stringify({
    id,
    seq: id,
    type: 'user_question',
    ts: 1,
    attempt: 1,
    sessionId: 's',
    data: { question: 'Build it?', options: [{ id: 'go', label: 'Go', recommended: true }] },
    ...(phase ? { phase } : {}),
  })}\n\n`;
const start = (id: number, phase: 'live' | 'backlog') =>
  `id: ${id}\nevent: session_start\ndata: ${JSON.stringify({ id, type: 'session_start', ts: 1, attempt: 1, data: {}, phase })}\n\n`;
const CAUGHT_UP = 'event: caught_up\ndata: {}\n\n';

let root: Root;
let release: () => void;
let stream: ReadableStreamDefaultController<Uint8Array>;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  useQuestionAutoConfirm.setState({ live: [], stopped: [], autoConfirmed: [] });
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (!String(url).includes('/events')) {
        return Promise.resolve(
          new Response('{}', { headers: { 'content-type': 'application/json' } }),
        );
      }
      return new Promise<Response>((resolve) => {
        release = () =>
          resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  stream = controller;
                },
              }),
              { headers: { 'content-type': 'text/event-stream' } },
            ),
          );
      });
    }),
  );
  await act(async () => root.render(createElement(Harness, { sessionId: 's' })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  useWorkbenchStore.getState().detach();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = () =>
  act(async () => {
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
const send = (text: string) =>
  act(async () => {
    stream.enqueue(encoder.encode(text));
    await vi.advanceTimersByTimeAsync(1);
  });
const cut = () =>
  act(async () => {
    stream.error(new Error('cut'));
    await vi.advanceTimersByTimeAsync(0);
  });
const live = () => useQuestionAutoConfirm.getState().live;

describe('a question may auto-confirm only when it arrived live', () => {
  it('not when it is replayed on attach', async () => {
    await open();
    await send(question(1, 'backlog') + CAUGHT_UP);
    expect(useWorkbenchStore.getState().chat.some((n) => n.kind === 'question')).toBe(true);
    expect(live()).toEqual([]);
  });

  it('yes for a new question after caught_up', async () => {
    await open();
    await send(start(1, 'backlog') + CAUGHT_UP);
    await send(question(2, 'live'));
    expect(live()).toEqual([sessionScopedKey('s', 'e2')]);
  });

  it('not when a reconnect replays a pending question before its caught_up', async () => {
    await open();
    await send(start(1, 'backlog') + CAUGHT_UP);
    await cut();
    // The retry fires after its delay; the server replays what was missed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await open();
    await send(question(2, 'backlog'));
    expect(useWorkbenchStore.getState().chat.some((n) => n.kind === 'question')).toBe(true);
    expect(live()).toEqual([]);
    await send(CAUGHT_UP);
    expect(live()).toEqual([]);
  });

  it('not for a frame without the server marker', async () => {
    await open();
    await send(start(1, 'backlog') + CAUGHT_UP);
    await send(question(2));
    expect(live()).toEqual([]);
  });
});
