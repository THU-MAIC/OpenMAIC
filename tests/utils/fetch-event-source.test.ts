import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FetchEventSource, SseParser } from '@/lib/utils/fetch-event-source';

import { SSE_CASES } from './sse-cases';

const SSE_HEADERS = { 'content-type': 'text/event-stream' };

interface Connection {
  readonly init: RequestInit;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  readonly send: (text: string) => void;
  readonly end: () => void;
  readonly cancelled: () => boolean;
}

let connections: Connection[];
let fetchMock: ReturnType<typeof vi.fn>;

/** Each call answers with a stream the test writes to. */
function answerWithStreams(headers: Record<string, string> = SSE_HEADERS) {
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        connections.push({
          init,
          controller,
          send: (text) => controller.enqueue(new TextEncoder().encode(text)),
          end: () => controller.close(),
          cancelled: () => cancelled,
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers });
  });
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const sentHeaders = (index: number) => connections[index]!.init.headers as Record<string, string>;

function record(source: FetchEventSource, ...types: string[]) {
  const seen: Array<{ type: string; data?: string; lastEventId?: string; state: number }> = [];
  for (const type of types) {
    source.addEventListener(type, (event) => {
      const message = event as MessageEvent<string>;
      seen.push({
        type: event.type,
        data: message.data,
        lastEventId: message.lastEventId,
        state: source.readyState,
      });
    });
  }
  return seen;
}

beforeEach(() => {
  vi.useFakeTimers();
  connections = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('location', { href: 'https://app.example/page' });
  answerWithStreams();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SseParser', () => {
  const parse = (chunks: readonly string[]) => {
    const frames: unknown[] = [];
    const parser = new SseParser(
      (frame) => frames.push(frame),
      () => {},
    );
    for (const chunk of chunks) parser.feed(chunk);
    return frames;
  };
  // The BOM belongs to the decoder, which `FetchEventSource` covers below.
  const cases = SSE_CASES.filter(({ name }) => name !== 'leading BOM is skipped');

  it.each(cases)('$name, in one chunk', ({ body, expected }) => {
    expect(parse([body])).toEqual(expected);
  });

  it.each(cases)('$name, split at every position', ({ body, expected }) => {
    for (let at = 1; at < body.length; at++) {
      expect(parse([body.slice(0, at), '', body.slice(at)])).toEqual(expected);
    }
  });

  it('reports only a digits-only retry', () => {
    const retries: number[] = [];
    const parser = new SseParser(
      () => {},
      (ms) => retries.push(ms),
    );
    parser.feed('retry: 10\nretry: 1a\nretry: -1\nretry: 1.5\nretry:\nretry: 20\n');
    expect(retries).toEqual([10, 20]);
  });
});

describe('FetchEventSource on the back/forward cache', () => {
  const page = new EventTarget();
  const transition = (type: string, persisted: boolean) =>
    page.dispatchEvent(Object.assign(new Event(type), { persisted }));

  beforeEach(() => {
    vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
    vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  });

  it('lets go of the connection in the cache and resumes from the last id on return', async () => {
    const source = new FetchEventSource('/s');
    const seen = record(source, 'open', 'error');
    await settle();
    connections[0]!.send('id: 4\ndata: a\n\n');
    await settle();
    transition('pagehide', true);
    await settle();
    expect(connections[0]!.init.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    transition('pageshow', true);
    await settle();
    expect(seen.at(-1)).toMatchObject({ type: 'error', state: 0 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentHeaders(1)['last-event-id']).toBe('4');
    expect(source.readyState).toBe(1);
    source.close();
  });

  it('cancels a pending retry while cached', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    connections[0]!.end();
    await settle();
    transition('pagehide', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    source.close();
  });

  it('ignores a page that is not going into the cache', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    transition('pagehide', false);
    transition('pageshow', false);
    await settle();
    expect(connections[0]!.init.signal!.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    source.close();
  });

  it('stays closed when closed in the cache, and leaves no listeners behind', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    transition('pagehide', true);
    source.close();
    transition('pageshow', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.readyState).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('FetchEventSource', () => {
  it.each(SSE_CASES)('delivers "$name" split at every byte', async ({ body, expected }) => {
    const bytes = new TextEncoder().encode(body);
    const source = new FetchEventSource('/s');
    const types = [...new Set(['message', ...expected.map(({ type }) => type)])];
    const seen = record(source, ...types);
    await settle();
    for (const byte of bytes) connections[0]!.controller.enqueue(Uint8Array.of(byte));
    await settle();
    expect(seen.map(({ type, data, lastEventId }) => ({ type, data, lastEventId }))).toEqual(
      expected,
    );
    source.close();
  });

  it('asks for a low-priority, same-origin, uncached stream', async () => {
    const source = new FetchEventSource('/api/events?a=1');
    await settle();
    expect(source.url).toBe('https://app.example/api/events?a=1');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://app.example/api/events?a=1');
    expect(connections[0]!.init).toMatchObject({
      priority: 'low',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    expect(sentHeaders(0)).toEqual({ accept: 'text/event-stream' });
    source.close();
  });

  it('moves through the ready states and exposes the constants', async () => {
    const source = new FetchEventSource('/s');
    expect([source.CONNECTING, source.OPEN, source.CLOSED]).toEqual([0, 1, 2]);
    expect(FetchEventSource.CLOSED).toBe(2);
    expect(source.readyState).toBe(0);
    await settle();
    expect(source.readyState).toBe(1);
    source.close();
    expect(source.readyState).toBe(2);
  });

  it('calls onopen, onmessage and onerror, and routes named frames to their listeners only', async () => {
    const source = new FetchEventSource('/s');
    const calls: string[] = [];
    source.onopen = () => calls.push('open');
    source.onmessage = (event) => calls.push(`message:${(event as MessageEvent).data}`);
    source.onerror = () => calls.push('error');
    source.addEventListener('x', (event) => calls.push(`x:${event.data}`));
    await settle();
    connections[0]!.send('data: a\n\nevent: x\ndata: b\n\n');
    await settle();
    connections[0]!.end();
    await settle();
    expect(calls).toEqual(['open', 'message:a', 'x:b', 'error']);
    source.onerror = null;
    expect(source.onerror).toBeNull();
    source.close();
  });

  it('gives the frame its origin and last event id', async () => {
    const source = new FetchEventSource('/s');
    let message: MessageEvent | undefined;
    source.onmessage = (event) => (message = event as MessageEvent);
    await settle();
    connections[0]!.send('id: 9\ndata: a\n\n');
    await settle();
    expect(message).toMatchObject({ origin: 'https://app.example', lastEventId: '9' });
    source.close();
  });

  it('reconnects after the default delay with Last-Event-ID, dropping a partial frame', async () => {
    const source = new FetchEventSource('/s');
    const seen = record(source, 'open', 'message', 'error');
    await settle();
    connections[0]!.send('id: 3\ndata: a\n\nid: 4\ndata: partial\n');
    await settle();
    connections[0]!.end();
    await settle();
    expect(seen.at(-1)).toMatchObject({ type: 'error', state: 0 });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentHeaders(1)['last-event-id']).toBe('3');
    connections[1]!.send('data: b\n\n');
    await settle();
    expect(seen.map(({ type, data, state }) => [type, data, state])).toEqual([
      ['open', undefined, 1],
      ['message', 'a', 1],
      ['error', undefined, 0],
      ['open', undefined, 1],
      ['message', 'b', 1],
    ]);
    expect(seen.at(-1)!.lastEventId).toBe('3');
    source.close();
  });

  it('sends no Last-Event-ID once an empty id cleared it', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    connections[0]!.send('id: 3\ndata: a\n\nid\ndata: b\n\n');
    await settle();
    connections[0]!.end();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentHeaders(1)).not.toHaveProperty('last-event-id');
    source.close();
  });

  it('sends a non-ASCII id as its UTF-8 bytes, which fetch can carry', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    connections[0]!.send('id: 课堂\ndata: a\n\n');
    await settle();
    connections[0]!.end();
    await vi.advanceTimersByTimeAsync(3_000);
    const sent = sentHeaders(1)['last-event-id']!;
    expect(new Headers({ 'last-event-id': sent }).get('last-event-id')).toBe(sent);
    expect(new TextDecoder().decode(Uint8Array.from(sent, (c) => c.charCodeAt(0)))).toBe('课堂');
    source.close();
  });

  it('keeps an id committed by a frame without data', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    connections[0]!.send('id: 5\n\n');
    await settle();
    connections[0]!.end();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentHeaders(1)['last-event-id']).toBe('5');
    source.close();
  });

  it('honours retry across a reconnect', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    connections[0]!.send('retry: 7000\n\n');
    await settle();
    connections[0]!.end();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    source.close();
  });

  it.each([
    ['a dropped connection', () => connections[0]!.controller.error(new Error('reset'))],
    ['a clean end', () => connections[0]!.end()],
  ])('retries after %s', async (_name, drop) => {
    const source = new FetchEventSource('/s');
    const seen = record(source, 'error');
    await settle();
    drop();
    await settle();
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    source.close();
  });

  it('retries when the request itself fails', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const source = new FetchEventSource('/s');
    const seen = record(source, 'open', 'error');
    await settle();
    expect(seen).toMatchObject([{ type: 'error', state: 0 }]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen.at(-1)).toMatchObject({ type: 'open', state: 1 });
    source.close();
  });

  it('retries when a request fails but the same URL answers without a redirect', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const source = new FetchEventSource('/s');
    const seen = record(source, 'error');
    await settle();
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ redirect: 'manual', priority: 'low' });
    expect(connections[0]!.cancelled()).toBe(true);
    expect(seen).toMatchObject([{ type: 'error', state: 0 }]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(source.readyState).toBe(1);
    source.close();
  });

  it('closes without a retry when the failure was a refused redirect', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ type: 'opaqueredirect', body: null });
    const source = new FetchEventSource('/s');
    const seen = record(source, 'open', 'error');
    await settle();
    expect(seen).toMatchObject([{ type: 'error', state: 2 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('close() during that check neither reports nor retries', async () => {
    let answer!: (response: unknown) => void;
    fetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const source = new FetchEventSource('/s');
    const seen = record(source, 'error');
    await settle();
    source.close();
    answer({ type: 'opaqueredirect', body: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['204', new Response(null, { status: 204 })],
    ['404', new Response('Not found', { status: 404 })],
    ['500', new Response('x', { status: 500, headers: SSE_HEADERS })],
    ['201', new Response('x', { status: 201, headers: SSE_HEADERS })],
    ['the wrong type', new Response('{}', { headers: { 'content-type': 'application/json' } })],
    ['no type', new Response(new Uint8Array(1), { headers: {} })],
  ])('closes without a retry on %s', async (_name, response) => {
    if (_name === 'no type') response.headers.delete('content-type');
    fetchMock.mockResolvedValueOnce(response);
    const source = new FetchEventSource('/s');
    const seen = record(source, 'open', 'error');
    await settle();
    expect(seen).toMatchObject([{ type: 'error', state: 2 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a type with parameters, in any case', async () => {
    answerWithStreams({ 'content-type': 'Text/Event-Stream; charset=utf-8' });
    const source = new FetchEventSource('/s');
    await settle();
    expect(source.readyState).toBe(1);
    source.close();
  });

  it('a listener that closes on open reads nothing from the stream', async () => {
    const source = new FetchEventSource('/s');
    const seen = record(source, 'message');
    source.onopen = () => source.close();
    await settle();
    expect(connections[0]!.cancelled()).toBe(true);
    expect(seen).toEqual([]);
  });

  it('fires open in the same turn as the state change, before anything is read', async () => {
    const source = new FetchEventSource('/s');
    let openedByNextMicrotask: boolean | undefined;
    let opened = false;
    source.addEventListener('open', () => (opened = true));
    let state = source.readyState;
    Object.defineProperty(source, 'readyState', {
      get: () => state,
      set(next: 0 | 1 | 2) {
        state = next;
        if (next === 1) queueMicrotask(() => (openedByNextMicrotask = opened));
      },
    });
    await settle();
    expect(openedByNextMicrotask).toBe(true);
    source.close();
  });

  it('starts each connection with a fresh decoder', async () => {
    const source = new FetchEventSource('/s');
    const seen = record(source, 'message');
    await settle();
    // The first two bytes of a three-byte character, then the connection ends.
    connections[0]!.controller.enqueue(Uint8Array.of(0xe8, 0xaf));
    connections[0]!.end();
    await vi.advanceTimersByTimeAsync(3_000);
    connections[1]!.send('data: a\n\n');
    await settle();
    expect(seen.map(({ data }) => data)).toEqual(['a']);
    source.close();
  });

  it('keeps an on* handler where it was first assigned among the listeners', async () => {
    const source = new FetchEventSource('/s');
    const order: string[] = [];
    source.addEventListener('message', () => order.push('first'));
    source.onmessage = () => order.push('handler');
    source.addEventListener('message', () => order.push('last'));
    await settle();
    connections[0]!.send('data: a\n\n');
    await settle();
    expect(order).toEqual(['first', 'handler', 'last']);
    order.length = 0;
    source.onmessage = () => order.push('replaced');
    connections[0]!.send('data: b\n\n');
    await settle();
    expect(order).toEqual(['first', 'replaced', 'last']);
    order.length = 0;
    source.onmessage = null;
    source.onmessage = () => order.push('again');
    connections[0]!.send('data: c\n\n');
    await settle();
    expect(order).toEqual(['first', 'again', 'last']);
    source.close();
  });

  it('close() aborts the request, cancels the body and stops retrying', async () => {
    const source = new FetchEventSource('/s');
    const seen = record(source, 'error');
    await settle();
    source.close();
    await settle();
    expect(connections[0]!.init.signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([]);
  });

  it('close() during a pending retry cancels it', async () => {
    const source = new FetchEventSource('/s');
    await settle();
    connections[0]!.end();
    await settle();
    source.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('close() while the request is pending opens nothing', async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
    const source = new FetchEventSource('/s');
    const seen = record(source, 'open', 'error');
    source.close();
    resolve(new Response('data: a\n\n', { headers: SSE_HEADERS }));
    await settle();
    expect(seen).toEqual([]);
    expect(source.readyState).toBe(2);
  });

  it('a listener that closes receives nothing more from the same chunk', async () => {
    const source = new FetchEventSource('/s');
    const data: string[] = [];
    source.onmessage = (event) => {
      data.push((event as MessageEvent).data);
      source.close();
    };
    await settle();
    connections[0]!.send('data: a\n\ndata: b\n\n');
    await settle();
    expect(data).toEqual(['a']);
    expect(connections[0]!.cancelled()).toBe(true);
  });

  it('an error listener that closes stops the retry', async () => {
    const source = new FetchEventSource('/s');
    source.onerror = () => source.close();
    await settle();
    connections[0]!.end();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['2147483648', '2147483648'],
    ['a 400-digit number', '9'.repeat(400)],
  ])('a retry of %s cannot overflow the timer into a tight loop', async (_name, retry) => {
    fetchMock.mockImplementation(
      async () => new Response(`retry: ${retry}\n\n`, { headers: SSE_HEADERS }),
    );
    const source = new FetchEventSource('/s');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    source.close();
  });

  it.each([
    ['an empty 200', '', 11],
    ['an empty 200 that asked for retry: 0', 'retry: 0\n\n', 31],
  ])('%s cannot spin', async (_name, body, atMost) => {
    fetchMock.mockImplementation(async () => new Response(body, { headers: SSE_HEADERS }));
    const source = new FetchEventSource('/s');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(atMost);
    source.close();
  });
});
