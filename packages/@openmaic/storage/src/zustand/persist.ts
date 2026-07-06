import { DEFAULT_KV_SCOPE, type KVScope, type KVStore } from '../kv/types.js';

/**
 * The `{ state, version }` envelope zustand's `persist` middleware reads and
 * writes. Mirrored structurally here so this package doesn't depend on zustand —
 * the returned adapter is assignable to persist's `storage` option by shape.
 */
export interface PersistedValue<S> {
  state: S;
  version?: number;
}

/** The subset of zustand's `PersistStorage<S>` this adapter provides. */
export interface PersistStorageLike<S> {
  getItem(name: string): Promise<PersistedValue<S> | null>;
  setItem(name: string, value: PersistedValue<S>): Promise<void>;
  removeItem(name: string): Promise<void>;
}

/**
 * Adapt a {@link KVStore} into a zustand `persist` storage, so a store's
 * business logic (including its own `version` / `migrate` / `merge`) is
 * untouched while its bytes move from raw `localStorage` to a KV backend that a
 * server-backed deployment can sync. Wire it as:
 *
 * ```ts
 * persist(fn, { name: 'settings-storage', storage: kvPersistStorage(kv, 'account') })
 * ```
 *
 * The KVStore owns serialization, so the whole envelope is stored as a
 * structured value (no double JSON encoding). Scope defaults to `account`; pass
 * `device` for machine-local stores.
 */
export function kvPersistStorage<S>(
  kv: KVStore,
  scope: KVScope = DEFAULT_KV_SCOPE,
): PersistStorageLike<S> {
  return {
    getItem: (name) => kv.get<PersistedValue<S>>(name, scope),
    setItem: (name, value) => kv.set(name, value, scope),
    removeItem: (name) => kv.remove(name, scope),
  };
}
