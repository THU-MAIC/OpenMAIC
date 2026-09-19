/**
 * Isolated PPTX parse. Runs in a worker thread so linkedom's document/Node
 * never appear on the Next.js request process (`typeof document` stays
 * undefined for concurrent SSR).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { parseHTML } from 'linkedom/worker';

class WorkerXHR {
  static UNSENT = 0;
  static OPENED = 1;
  static HEADERS_RECEIVED = 2;
  static LOADING = 3;
  static DONE = 4;
  UNSENT = 0;
  OPENED = 1;
  HEADERS_RECEIVED = 2;
  LOADING = 3;
  DONE = 4;
  readyState = 0;
  status = 0;
  statusText = '';
  response = null;
  responseText = '';
  responseType = '';
  responseURL = '';
  onreadystatechange = null;
  onload = null;
  onerror = null;
  onprogress = null;
  method = 'GET';
  url = '';
  headers = new Map();
  aborted = false;

  open(method, url) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
    this.onreadystatechange?.();
  }
  setRequestHeader(name, value) {
    this.headers.set(name, value);
  }
  overrideMimeType() {}
  abort() {
    this.aborted = true;
  }
  getAllResponseHeaders() {
    return '';
  }
  getResponseHeader() {
    return null;
  }
  send(body) {
    const headers = Object.fromEntries(this.headers);
    const init = { method: this.method, headers };
    if (body != null && this.method !== 'GET' && this.method !== 'HEAD') init.body = body;
    void this.dispatch(init);
  }
  async dispatch(init) {
    try {
      const response = await fetch(this.url, init);
      if (this.aborted) return;
      this.status = response.status;
      this.statusText = response.statusText;
      this.responseURL = response.url;
      this.readyState = 2;
      this.onreadystatechange?.();
      const buffer = Buffer.from(await response.arrayBuffer());
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

function installHost() {
  globalThis.XMLHttpRequest = WorkerXHR;
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  window.XMLHttpRequest = WorkerXHR;
  Object.assign(globalThis, {
    document,
    DOMParser: window.DOMParser,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    location: {
      href: 'http://localhost/',
      origin: 'http://localhost',
      protocol: 'http:',
      host: 'localhost',
      hostname: 'localhost',
      port: '',
      pathname: '/',
      search: '',
      hash: '',
    },
  });
}

async function upload(blob, _filename) {
  const buffer = Buffer.from(await blob.arrayBuffer());
  const mime = blob.type || 'application/octet-stream';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

installHost();
const { importPptx } = await import('@openmaic/importer');
try {
  const buffer = workerData.buffer;
  const slides = await importPptx(buffer, { upload });
  parentPort.postMessage({ slides });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
