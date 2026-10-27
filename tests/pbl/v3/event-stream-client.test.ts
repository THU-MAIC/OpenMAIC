import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLearningStream, LearningStreamError } from '@/lib/pbl/v3/event-stream';
const encoder = new TextEncoder();
afterEach(() => vi.unstubAllGlobals());
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
        signal: controller.signal,
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
});
