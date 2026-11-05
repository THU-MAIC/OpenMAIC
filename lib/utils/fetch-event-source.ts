/**
 * `EventSource`, on `fetch(url, { priority: 'low' })`.
 *
 * Chromium gives a native `EventSource` a medium priority that cannot be
 * lowered. On a connection it rates 3G or slower, its ResourceScheduler holds
 * low-priority requests while `in-flight low + 3 x in-flight medium >= 8`, so
 * three open streams hold back every lazy script chunk, batch after batch. As
 * low-priority requests the same streams count once each and leave room for the
 * chunks.
 *
 * The price: the stream itself now queues behind other low-priority requests,
 * and how long depends on how many are in flight and how slow they are. On that
 * kind of connection `open` can come tens of seconds after the constructor, so
 * a caller's timeout should count from `open`.
 *
 * Semantics follow the HTML spec's server-sent events section, and Chromium
 * where the spec leaves a choice (the last event id survives a reconnect).
 * Same-origin only, so `withCredentials` is not supported. Browsers that do not
 * implement `priority` ignore it and behave the same otherwise.
 */

const DEFAULT_RECONNECT_MS = 3_000;
/** How long frames may run before the page gets a turn: reads resolve as microtasks. */
const MAX_BUSY_MS = 50;
/** Native has no floor; this one stops `retry: 0` over an empty 200 from spinning. */
const MIN_RECONNECT_MS = 1_000;
/** A longer delay overflows `setTimeout`, which then fires at once. */
const MAX_RECONNECT_MS = 2_147_483_647;

export interface SseFrame {
  readonly type: string;
  readonly data: string;
  readonly lastEventId: string;
}

/** The spec's line parser. One per connection: a partial frame never survives a reconnect. */
export class SseParser {
  private partial = '';
  private skipLf = false;
  private type = '';
  private data: string | null = null;
  private idBuffer: string;
  private stopped = false;
  lastEventId: string;

  constructor(
    private readonly onFrame: (frame: SseFrame) => void,
    private readonly onRetry: (ms: number) => void,
    lastEventId = '',
  ) {
    this.lastEventId = lastEventId;
    this.idBuffer = lastEventId;
  }

  /** Ends parsing mid-chunk: a listener that calls `close()` receives nothing more. */
  stop(): void {
    this.stopped = true;
  }

  feed(chunk: string): void {
    if (!chunk) return;
    let index = 0;
    if (this.skipLf && chunk[0] === '\n') index = 1;
    this.skipLf = false;
    let start = index;
    for (; index < chunk.length && !this.stopped; index++) {
      const code = chunk.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;
      const line = this.partial + chunk.slice(start, index);
      this.partial = '';
      if (code === 13) {
        // CRLF can straddle two chunks.
        if (index + 1 === chunk.length) this.skipLf = true;
        else if (chunk[index + 1] === '\n') index++;
      }
      start = index + 1;
      this.processLine(line);
    }
    if (!this.stopped) this.partial += chunk.slice(start);
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    const colon = line.indexOf(':');
    if (colon === 0) return;
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'data') this.data = this.data === null ? value : `${this.data}\n${value}`;
    else if (field === 'event') this.type = value;
    else if (field === 'id') {
      if (!value.includes('\0')) this.idBuffer = value;
    } else if (field === 'retry' && /^[0-9]+$/.test(value)) this.onRetry(Number(value));
  }

  private dispatch(): void {
    this.lastEventId = this.idBuffer;
    const { data, type } = this;
    this.data = null;
    this.type = '';
    if (data === null) return;
    this.onFrame({ type: type || 'message', data, lastEventId: this.lastEventId });
  }
}

/**
 * `fetch` throws on a header value above U+00FF and sends the rest one byte per
 * code unit, so an id's UTF-8 bytes go out as they do from a native `EventSource`.
 */
function utf8AsByteString(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join('');
}

type Handler = ((event: Event) => void) | null;

export class FetchEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = FetchEventSource.CONNECTING;

  private readonly handlers = new Map<string, Handler>();
  private controller: AbortController | null = null;
  private parser: SseParser | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconnectMs = DEFAULT_RECONNECT_MS;
  private lastEventId = '';
  private suspended = false;

  constructor(url: string) {
    super();
    this.url = new URL(url, location.href).href;
    globalThis.addEventListener?.('pagehide', this.onPageHide);
    globalThis.addEventListener?.('pageshow', this.onPageShow);
    void this.connect();
  }

  /**
   * A response still receiving data evicts its page from the back/forward cache,
   * where a native stream would not, and every route here pings. So a page going
   * in lets go of the connection, and picks it up where it left off on return.
   */
  private readonly onPageHide = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    this.suspended = true;
    this.stopConnection();
  };

  private readonly onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted || !this.suspended) return;
    this.suspended = false;
    this.scheduleReconnect();
  };

  get onopen(): Handler {
    return this.handlers.get('open') ?? null;
  }
  set onopen(handler: Handler) {
    this.setHandler('open', handler);
  }
  get onmessage(): Handler {
    return this.handlers.get('message') ?? null;
  }
  set onmessage(handler: Handler) {
    this.setHandler('message', handler);
  }
  get onerror(): Handler {
    return this.handlers.get('error') ?? null;
  }
  set onerror(handler: Handler) {
    this.setHandler('error', handler);
  }

  close(): void {
    this.readyState = FetchEventSource.CLOSED;
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    globalThis.removeEventListener?.('pageshow', this.onPageShow);
    this.stopConnection();
  }

  private stopConnection(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.parser?.stop();
    this.controller?.abort();
    this.controller = null;
  }

  /** Native's overload: a named frame reaches its listener as a `MessageEvent`. */
  override addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  override addEventListener(
    type: string,
    listener: unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
  }

  /** The first assignment fixes the handler's place among the listeners, as for a native one. */
  private setHandler(type: string, handler: Handler): void {
    if (!this.handlers.has(type)) {
      this.addEventListener(type, (event) => this.handlers.get(type)?.call(this, event));
    }
    this.handlers.set(type, handler);
  }

  private async connect(): Promise<void> {
    this.timer = null;
    const controller = new AbortController();
    this.controller = controller;
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.lastEventId) headers['last-event-id'] = utf8AsByteString(this.lastEventId);

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const response = await fetch(this.url, {
        headers,
        cache: 'no-store',
        credentials: 'same-origin',
        priority: 'low',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || mime !== 'text/event-stream' || !response.body) {
        void response.body?.cancel().catch(() => {});
        // A definite answer from the server: native gives up here, and callers
        // rely on it (the freshness stream stops on a 404).
        this.giveUp();
        return;
      }
      reader = response.body.getReader();
    } catch {
      if (controller.signal.aborted) return;
      const redirected = await this.answersWithRedirect(headers, controller.signal);
      if (controller.signal.aborted) return;
      if (redirected) this.giveUp();
      else this.scheduleReconnect();
      return;
    }

    this.readyState = FetchEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
    if (controller.signal.aborted) {
      void reader.cancel().catch(() => {});
      return;
    }

    const parser = new SseParser(
      (frame) => this.dispatchFrame(frame),
      (ms) => {
        this.reconnectMs = ms;
      },
      this.lastEventId,
    );
    this.parser = parser;
    const decoder = new TextDecoder();
    let busySince = performance.now();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || controller.signal.aborted) break;
        parser.feed(decoder.decode(value, { stream: true }));
        this.lastEventId = parser.lastEventId;
        if (performance.now() - busySince > MAX_BUSY_MS) {
          await new Promise((resolve) => setTimeout(resolve));
          busySince = performance.now();
        }
        if (controller.signal.aborted) break;
      }
    } catch {
      // A dropped connection reads as an error; handled with the clean end below.
    }
    void reader.cancel().catch(() => {});
    if (!controller.signal.aborted) this.scheduleReconnect();
  }

  /**
   * Fetch reports a redirect the browser refused to follow, such as a login page
   * on another origin, exactly as it reports a dropped connection. Native gives
   * up on the first and retries the second, and callers rely on the difference,
   * so ask again without following. A same-origin redirect never gets here unless
   * its target failed, which is the one case this treats differently from native.
   */
  private async answersWithRedirect(
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const response = await fetch(this.url, {
        headers,
        cache: 'no-store',
        credentials: 'same-origin',
        priority: 'low',
        redirect: 'manual',
        signal,
      });
      void response.body?.cancel().catch(() => {});
      return response.type === 'opaqueredirect';
    } catch {
      return false;
    }
  }

  private giveUp(): void {
    this.close();
    this.dispatchEvent(new Event('error'));
  }

  private dispatchFrame(frame: SseFrame): void {
    this.dispatchEvent(
      new MessageEvent(frame.type, {
        data: frame.data,
        lastEventId: frame.lastEventId,
        origin: new URL(this.url).origin,
      }),
    );
  }

  private scheduleReconnect(): void {
    this.parser = null;
    this.readyState = FetchEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
    // A listener may have closed the stream.
    if (this.readyState !== FetchEventSource.CONNECTING) return;
    const delay = Math.min(Math.max(this.reconnectMs, MIN_RECONNECT_MS), MAX_RECONNECT_MS);
    this.timer = setTimeout(() => void this.connect(), delay);
  }
}
