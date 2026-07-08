// Test shims for the handful of browser globals the backends touch that Node
// does not provide natively. The backends themselves take their `Storage` /
// `IDBFactory` by injection, so tests pass fresh isolated instances; these
// shims only cover the ambient APIs (object URLs, IndexedDB factory type,
// crypto) a real browser supplies.
import { webcrypto } from 'node:crypto';
import { beforeEach } from 'vitest';

// Node ≥20 exposes `globalThis.crypto`, but guard for older/edge runners so
// content-hashing (crypto.subtle.digest) works the same as in a browser.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// object-URL registry: `createObjectURL(blob)` mints a unique `blob:` URL and
// remembers the blob so tests can resolve the URL back to its bytes (the real
// browser provides both natively; Node provides neither).
const objectUrls = new Map<string, Blob>();
let seq = 0;

URL.createObjectURL = (obj: Blob | MediaSource): string => {
  const url = `blob:maic-test/${seq++}`;
  objectUrls.set(url, obj as Blob);
  return url;
};
URL.revokeObjectURL = (url: string): void => {
  objectUrls.delete(url);
};

/** Test-only: resolve an object URL minted by the polyfill back to its blob. */
export function blobForObjectUrl(url: string): Blob | undefined {
  return objectUrls.get(url);
}

// Reset the object-URL registry between tests so nothing bleeds across cases
// (the override is a global; without this the map grows for the whole run).
beforeEach(() => {
  objectUrls.clear();
  seq = 0;
});

/**
 * Test-only in-memory `Storage` (localStorage-shaped) for injecting into the
 * browser KV backend. A fresh instance per test keeps cases isolated without
 * touching any ambient global.
 */
export class MemoryStorage implements Storage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(key: string): string | null {
    return this.m.has(key) ? this.m.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.m.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.m.delete(key);
  }
  setItem(key: string, value: string): void {
    this.m.set(key, String(value));
  }
  [name: string]: unknown;
}
