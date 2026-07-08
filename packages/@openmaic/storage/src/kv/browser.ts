import { DEFAULT_KV_SCOPE, type KVScope, type KVStore } from './types.js';

export interface BrowserKVStoreOptions {
  /**
   * Backing `Storage`. Defaults to the ambient `localStorage`. Injectable so
   * tests pass an isolated instance and callers can point at `sessionStorage`.
   */
  storage?: Storage;
  /**
   * Key namespace prefix, keeping KV entries from colliding with other
   * `localStorage` keys the app writes. Defaults to `maic`.
   */
  namespace?: string;
}

/**
 * Browser `KVStore` backend over a `Storage` (localStorage by default). Both
 * scopes live in the same `Storage`; the scope is encoded in the key prefix so
 * `device` and `account` never collide. In a server-backed deployment the
 * `account` scope is served by a different backend, but `device` stays on a
 * backend like this one — hence the scope is part of the primitive, not the
 * backend choice.
 */
export class BrowserKVStore implements KVStore {
  private readonly storage: Storage;
  private readonly namespace: string;

  constructor(options: BrowserKVStoreOptions = {}) {
    this.storage = options.storage ?? globalThis.localStorage;
    this.namespace = options.namespace ?? 'maic';
  }

  private prefix(scope: KVScope): string {
    return `${this.namespace}:${scope}:`;
  }

  private storageKey(key: string, scope: KVScope): string {
    return this.prefix(scope) + key;
  }

  async get<T>(key: string, scope: KVScope = DEFAULT_KV_SCOPE): Promise<T | null> {
    const raw = this.storage.getItem(this.storageKey(key, scope));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, scope: KVScope = DEFAULT_KV_SCOPE): Promise<void> {
    const json = JSON.stringify(value);
    // `JSON.stringify` yields `undefined` for values JSON can't represent
    // (`undefined`, a function, a symbol). Storing that coerces to the literal
    // string "undefined", which then throws on read — so treat it as a removal
    // rather than writing an unreadable entry.
    if (json === undefined) {
      return this.remove(key, scope);
    }
    this.storage.setItem(this.storageKey(key, scope), json);
  }

  async remove(key: string, scope: KVScope = DEFAULT_KV_SCOPE): Promise<void> {
    this.storage.removeItem(this.storageKey(key, scope));
  }

  async keys(prefix = '', scope: KVScope = DEFAULT_KV_SCOPE): Promise<string[]> {
    const scopePrefix = this.prefix(scope);
    const out: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const full = this.storage.key(i);
      if (full === null || !full.startsWith(scopePrefix)) continue;
      const key = full.slice(scopePrefix.length);
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }
}
