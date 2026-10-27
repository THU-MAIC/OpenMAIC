import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readLearningStream,
  LearningStreamError,
  LEARNING_STREAM_IDLE_MS,
} from '@/lib/pbl/v3/event-stream';
const encoder = new TextEncoder();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function respond(chunks: Uint8Array[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const chunk of chunks) c.enqueue(chunk);
              c.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ),
  );
}
describe('learning SSE client', () => {
  it('handles split UTF-8 and multiple frames, preserves the deliberate-client header and replaces snapshots', async () => {
    const text =
      ': ping\n\nevent: learning\ndata: {"view":{"id":"study","title":"任务","revision":1},"workbench":null}\n\nevent: learning\ndata: {"view":{"id":"study","revision":2},"workbench":null}\n\n';
    const bytes = encoder.encode(text);
    respond(Array.from(bytes, (byte) => new Uint8Array([byte])));
    const receive = vi.fn();
    const controller = new AbortController();
    await readLearningStream('study', controller.signal, receive);
    expect(receive.mock.calls.map(([snap]) => snap.view.revision)).toEqual([1, 2]);
    expect(receive.mock.calls[0]![0].view.title).toBe('任务');
    expect(fetch).toHaveBeenCalledWith(
      '/api/pbl/v3/events?id=study',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: { 'x-openmaic-sandbox': '1', accept: 'text/event-stream' },
      }),
    );
  });
  it('receives a complete reply beyond the former SSE frame-size cutoff', async () => {
    const text = 'x'.repeat(8 * 1024 * 1024 + 1);
    respond([
      encoder.encode(
        'event: learning\ndata: ' +
          JSON.stringify({
            view: { id: 'study', messages: [{ role: 'assistant', text }] },
            workbench: null,
          }) +
          '\n\n',
      ),
    ]);
    const receive = vi.fn();
    await readLearningStream('study', new AbortController().signal, receive);
    expect(receive.mock.calls[0]![0].view.messages[0].text).toBe(text);
  });
  it('refuses the wrong study and stale messages after cancellation', async () => {
    respond([encoder.encode('event: learning\ndata: {"view":{"id":"other"}}\n\n')]);
    const receive = vi.fn();
    await expect(
      readLearningStream('study', new AbortController().signal, receive),
    ).rejects.toThrow('Unexpected');
    expect(receive).not.toHaveBeenCalled();
    respond([encoder.encode('event: learning\ndata: {"view":{"id":"study"}}\n\n')]);
    const c = new AbortController();
    c.abort();
    await readLearningStream('study', c.signal, receive);
    expect(receive).not.toHaveBeenCalled();
  });
  it('surfaces permanent refusal separately from retryable transport loss', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 403 })),
    );
    await expect(
      readLearningStream('study', new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ status: 403 });
    respond([encoder.encode('event: retry\ndata: {}\n\n')]);
    await expect(
      readLearningStream('study', new AbortController().signal, vi.fn()),
    ).rejects.toEqual(new LearningStreamError(503));
  });
  function live() {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                stream = controller;
              },
              cancel,
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    );
    return { send: (text: string) => stream.enqueue(encoder.encode(text)), cancel };
  }
  const snapshot =
    'event: learning\ndata: {"view":{"id":"study","revision":1},"workbench":null}\n\n';
  const observed = 'event: observed\ndata: {"id":"study"}\n\n';

  it('times out stalled response headers and cancels a response arriving after retirement', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const receive = vi.fn();
    const result = readLearningStream('study', new AbortController().signal, receive).catch(
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(LEARNING_STREAM_IDLE_MS);
    expect(await result).toEqual(new LearningStreamError(408));
    expect(vi.mocked(fetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    'does not mistake transport pings for a successful projection (snapshot=%s)',
    async (initial) => {
      vi.useFakeTimers();
      const stream = live();
      const result = readLearningStream('study', new AbortController().signal, vi.fn()).catch(
        (e) => e,
      );
      await vi.advanceTimersByTimeAsync(0);
      if (initial) stream.send(snapshot);
      for (let i = 0; i < 3; i++) {
        stream.send(': ping\n\n');
        await vi.advanceTimersByTimeAsync(25_000);
      }
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toEqual(new LearningStreamError(408));
      expect(stream.cancel).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('recovers a silent stream after a snapshot even if underlying cancellation never settles', async () => {
    vi.useFakeTimers();
    const stream = live();
    stream.cancel.mockImplementation(() => new Promise(() => {}));
    const receive = vi.fn();
    const result = readLearningStream('study', new AbortController().signal, receive).catch(
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(0);
    stream.send(snapshot);
    await vi.advanceTimersByTimeAsync(LEARNING_STREAM_IDLE_MS);
    expect(await result).toEqual(new LearningStreamError(408));
    expect(receive).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an unchanged, successfully observed workspace connected for arbitrarily long work', async () => {
    vi.useFakeTimers();
    const stream = live();
    const controller = new AbortController();
    const receive = vi.fn();
    let ended = false;
    const result = readLearningStream('study', controller.signal, receive)
      .catch(() => {})
      .finally(() => {
        ended = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    stream.send(snapshot);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      stream.send(observed);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(ended).toBe(false);
    expect(receive).toHaveBeenCalledOnce();
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requires the initial snapshot and rejects a confirmation for another study', async () => {
    vi.useFakeTimers();
    let stream = live();
    let result = readLearningStream('study', new AbortController().signal, vi.fn()).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      stream.send(observed);
    }
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toEqual(new LearningStreamError(408));
    stream = live();
    result = readLearningStream('study', new AbortController().signal, vi.fn()).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    stream.send('event: observed\ndata: {"id":"other"}\n\n');
    expect(await result).toMatchObject({ message: 'Unexpected learning session.' });
  });

  it('does not time out a snapshot that is actively transferring beyond one idle window', async () => {
    vi.useFakeTimers();
    const stream = live();
    const controller = new AbortController();
    const receive = vi.fn();
    const result = readLearningStream('study', controller.signal, receive).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    stream.send('event: learning\ndata: {"view":{"id":"study","title":"');
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      stream.send('still transferring ');
      await vi.advanceTimersByTimeAsync(0);
    }
    stream.send('"},"workbench":null}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenCalledOnce();
    controller.abort();
    await result;
  });
});
