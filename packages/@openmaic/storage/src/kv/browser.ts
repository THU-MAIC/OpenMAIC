import { assertKVScope, DEFAULT_KV_SCOPE, type KVScope, type LocalKVStore } from './types.js';

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
export class BrowserKVStore implements LocalKVStore {
  /** Brand: every value stays on the machine, so this may back another store's `device` scope. */
  readonly isLocalKVStore = true as const;
  /** And therefore its own `device` scope never leaves the device. */
  readonly servesDeviceScopeLocally = true as const;
  private readonly storage: Storage;
  private readonly namespace: string;

  constructor(options: BrowserKVStoreOptions = {}) {
    this.storage = options.storage ?? globalThis.localStorage;
    this.namespace = options.namespace ?? 'maic';
  }

  private prefix(scope: KVScope): string {
    // Fail closed rather than folding an unknown scope into a new key prefix,
    // where it would silently create a third, invisible namespace.
    return `${this.namespace}:${assertKVScope(scope)}:`;
  }

  private storageKey(key: string, scope: KVScope): string {
    // No key validation: the primitive's key domain is a truly opaque, unbounded
    // string. `Storage` accepts any string key, and a rule here would be a
    // transport concern reaching back into the primitive — making a key the
    // browser can perfectly well store unreadable. Only the scope (a fixed
    // two-value axis) is narrowed.
    return this.prefix(scope) + key;
  }

  async get<T>(key: string, scope: KVScope = DEFAULT_KV_SCOPE): Promise<T | null> {
    const raw = this.storage.getItem(this.storageKey(key, scope));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, value: T, scope: KVScope = DEFAULT_KV_SCOPE): Promise<void> {
    // Scope and key first, before anything can run caller code. `JSON.stringify`
    // invokes `toJSON` and getters, so validating after it would let a value
    // observe (and react to) a write that is about to be rejected anyway.
    const storageKey = this.storageKey(key, scope);
    // A value with no JSON representation at all is a removal — storing it would
    // coerce to the literal string "undefined" and throw on the next read. Decided
    // by inspecting the value, exactly as the HTTP backend decides it: a
    // `JSON.stringify` probe would also catch `{ toJSON: () => undefined }`, which
    // the HTTP backend rejects, and the two backends must not disagree about
    // whether a write was a delete.
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      return this.remove(key, scope);
    }
    const json = JSON.stringify(value);
    if (json === undefined) {
      // Reachable only via a `toJSON` that returns undefined. Refusing keeps this
      // backend's answer the same as the HTTP one, where the JSON gate rejects
      // any value defining `toJSON`.
      throw new Error(
        `@openmaic/storage: kv value for key ${JSON.stringify(key)} serialized to undefined ` +
          `(a toJSON returning undefined cannot be stored)`,
      );
    }
    this.storage.setItem(storageKey, json);
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
