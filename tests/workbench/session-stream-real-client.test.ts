// @vitest-environment jsdom
/**
 * `useWorkbenchStream` on the real `FetchEventSource`, with the request held the
 * way the browser's scheduler holds a low-priority one.
 */
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';

function Harness({ sessionId }: { sessionId: string }) {
  const attach = useWorkbenchStore((state) => state.attach);
  useLayoutEffect(() => {
    attach(sessionId, null);
  }, [attach, sessionId]);
  useWorkbenchStream(sessionId);
  return null;
}

const encoder = new TextEncoder();
const frame = (id: number, type: string, data: unknown) =>
  `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ id, seq: id, type, data, ts: 1, sessionId: 's' })}\n\n`;
const CAUGHT_UP = 'event: caught_up\ndata: {}\n\n';

let root: Root;
let release: () => void;
let stream: ReadableStreamDefaultController<Uint8Array>;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
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

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
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
const store = () => useWorkbenchStore.getState();

describe('replay on a stream the browser holds back', () => {
  it.each([1_000, 20_001, 60_000, 119_000])(
    'an old course link stays history when the request waits %i ms',
    async (heldMs) => {
      await advance(heldMs);
      expect(store().replaying).toBe(true);
      await open();
      await send(frame(1, 'stage_link', { stageId: 'old-course' }) + CAUGHT_UP);
      expect(store().stageLinkStageIds).toEqual(['old-course']);
      expect(store().replayedStageLinkCount).toBe(1);
      expect(store().replaying).toBe(false);
      expect(store().attached).toBe(true);
    },
  );

  it('an old course link stays history when the reconnect waits in the queue', async () => {
    await open();
    await send(frame(1, 'session_start', {}));
    await act(async () => {
      stream.error(new Error('cut'));
      await vi.advanceTimersByTimeAsync(0);
    });
    // The retry fires after 3 s, and the browser then holds the new request.
    await advance(30_000);
    expect(store().replaying).toBe(true);
    await open();
    await send(frame(2, 'stage_link', { stageId: 'old-course' }) + CAUGHT_UP);
    expect(store().replayedStageLinkCount).toBe(1);
  });

  it('an old course link stays history while a slow replay is still arriving', async () => {
    await open();
    for (let id = 1; id <= 25; id++) {
      await send(frame(id, 'session_start', {}));
      await advance(999);
    }
    expect(store().replaying).toBe(true);
    await send(frame(30, 'stage_link', { stageId: 'old-course' }) + CAUGHT_UP);
    expect(store().replayedStageLinkCount).toBe(1);
  });

  it('gives up 20 s after the last replay frame', async () => {
    await open();
    await advance(15_000);
    await send(frame(1, 'session_start', {}));
    await advance(19_998);
    expect(store().replaying).toBe(true);
    await advance(2);
    expect(store().replaying).toBe(false);
  });

  it('the backstop still ends a replay that keeps dropping', async () => {
    await open();
    for (let elapsed = 0; elapsed < 120_000; elapsed += 10_000) {
      await act(async () => {
        stream.error(new Error('cut'));
        await vi.advanceTimersByTimeAsync(0);
      });
      await advance(4_000);
      await open();
      await advance(6_000);
    }
    expect(store().replaying).toBe(false);
  });

  it('still gives up on an open stream that never sends caught_up', async () => {
    await advance(30_000);
    await open();
    await advance(19_999);
    expect(store().replaying).toBe(true);
    await advance(1);
    expect(store().replaying).toBe(false);
  });

  it('ends the wait on a stream that never opens', async () => {
    await advance(119_999);
    expect(store().replaying).toBe(true);
    await advance(1);
    expect(store().replaying).toBe(false);
  });
});
