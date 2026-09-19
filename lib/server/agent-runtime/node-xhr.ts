/**
 * Minimal XMLHttpRequest for Node. `@openmaic/importer` bundles pdfjs +
 * stream-http, both of which do `new XMLHttpRequest()` against the global
 * object. Node 18+ has fetch but no XHR, and `new global.XMLHttpRequest`
 * throws "XMLHttpRequest is not a constructor".
 */
type ReadyState = 0 | 1 | 2 | 3 | 4;

export class NodeXMLHttpRequest {
  static readonly UNSENT = 0 as const;
  static readonly OPENED = 1 as const;
  static readonly HEADERS_RECEIVED = 2 as const;
  static readonly LOADING = 3 as const;
  static readonly DONE = 4 as const;

  readonly UNSENT = 0 as const;
  readonly OPENED = 1 as const;
  readonly HEADERS_RECEIVED = 2 as const;
  readonly LOADING = 3 as const;
  readonly DONE = 4 as const;

  readyState: ReadyState = 0;
  status = 0;
  statusText = '';
  response: unknown = null;
  responseText = '';
  responseType = '';
  responseURL = '';
  withCredentials = false;
  onreadystatechange: ((this: NodeXMLHttpRequest) => void) | null = null;
  onload: ((this: NodeXMLHttpRequest) => void) | null = null;
  onerror: ((this: NodeXMLHttpRequest, error?: unknown) => void) | null = null;
  onprogress: ((this: NodeXMLHttpRequest) => void) | null = null;

  private method = 'GET';
  private url = '';
  private headers = new Map<string, string>();
  private responseHeaders = new Map<string, string>();
  private aborted = false;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
    this.onreadystatechange?.();
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  overrideMimeType(_mime: string): void {}

  abort(): void {
    this.aborted = true;
  }

  getAllResponseHeaders(): string {
    return [...this.responseHeaders.entries()]
      .map(([name, value]) => `${name}: ${value}`)
      .join('\r\n');
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders.get(name.toLowerCase()) ?? null;
  }

  send(body?: unknown): void {
    const headers: Record<string, string> = {};
    for (const [name, value] of this.headers) headers[name] = value;
    const init: RequestInit = { method: this.method, headers };
    if (body != null && this.method !== 'GET' && this.method !== 'HEAD') {
      init.body = body as BodyInit;
    }
    void this.dispatch(init);
  }

  private async dispatch(init: RequestInit): Promise<void> {
    try {
      const response = await fetch(this.url, init);
      if (this.aborted) return;
      this.status = response.status;
      this.statusText = response.statusText;
      this.responseURL = response.url;
      this.responseHeaders = new Map();
      response.headers.forEach((value, name) => {
        this.responseHeaders.set(name.toLowerCase(), value);
      });
      this.readyState = 2;
      this.onreadystatechange?.();
      const buffer = Buffer.from(await response.arrayBuffer());
      if (this.aborted) return;
      if (this.responseType === 'arraybuffer') {
        this.response = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        );
        this.responseText = '';
      } else {
        this.responseText = buffer.toString('latin1');
        this.response = this.responseText;
      }
      this.readyState = 3;
      this.onreadystatechange?.();
      this.onprogress?.();
      this.readyState = 4;
      this.onreadystatechange?.();
      this.onload?.();
    } catch (error) {
      if (this.aborted) return;
      this.readyState = 4;
      this.onreadystatechange?.();
      this.onerror?.(error);
    }
  }
}

export function installNodeXmlHttpRequest(): void {
  const ctor = NodeXMLHttpRequest as unknown as typeof XMLHttpRequest;
  if (typeof globalThis.XMLHttpRequest !== 'function') {
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
      value: ctor,
      writable: true,
      configurable: true,
    });
  }
  const window = globalThis.window as
    | (Window & { XMLHttpRequest?: typeof XMLHttpRequest })
    | undefined;
  if (window && typeof window.XMLHttpRequest !== 'function') {
    window.XMLHttpRequest = ctor;
  }
}
