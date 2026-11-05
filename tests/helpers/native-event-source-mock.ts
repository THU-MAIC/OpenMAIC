/**
 * `vi.mock('@/lib/utils/fetch-event-source', () => import(...this file))` for
 * suites that drive a `vi.stubGlobal('EventSource', ...)` fake: every stream the
 * product opens lands on the fake, whichever class opens it.
 */
export class FetchEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  constructor(url: string) {
    return new (globalThis as unknown as { EventSource: new (url: string) => object }).EventSource(
      url,
    ) as FetchEventSource;
  }
}
