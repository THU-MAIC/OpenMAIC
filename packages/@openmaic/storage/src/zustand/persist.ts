import {
  DEFAULT_KV_SCOPE,
  KVScopeViolationError,
  type DeviceSafeKVStore,
  type KVScope,
  type KVStore,
} from '../kv/types.js';

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
 * structured value (no double JSON encoding). Scope defaults to `account`.
 *
 * Asking for the `device` scope requires a {@link DeviceSafeKVStore} — a store
 * whose `device` writes stay on the machine. That admits both a fully-local
 * backend and an app-level composite (`HttpKVStore`) that routes `device` to a
 * local backend while syncing `account` to a server; both keep `device` off the
 * wire, which is the property that matters. It excludes a pure account
 * transport (`HttpAccountKV`), which has no local device backend and would put
 * a `device` value on the wire — the guard turns on "does `device` stay local",
 * not "is the whole store local", because confusing the two is exactly what
 * rejected the legitimate composite case. This adapter is the documented way to
 * hand a scope to a store chosen separately, so it is the natural place to pair
 * a store with `'device'` by accident; a plain `KVStore` parameter would accept
 * any such pairing, since a remote store satisfies `KVStore` structurally. The
 * overload makes an unsafe pairing a type error, and the runtime check refuses a
 * cast.
 */
export function kvPersistStorage<S>(kv: DeviceSafeKVStore, scope: 'device'): PersistStorageLike<S>;
export function kvPersistStorage<S>(kv: KVStore, scope?: 'account'): PersistStorageLike<S>;
// Deliberately no `(KVStore, KVScope)` overload: it would match every call the
// two above reject, handing the guard straight back. A caller holding a scope
// as a variable has to branch on it, which is the decision being forced.
export function kvPersistStorage<S>(
  kv: KVStore,
  scope: KVScope = DEFAULT_KV_SCOPE,
): PersistStorageLike<S> {
  if (scope === 'device' && (kv as Partial<DeviceSafeKVStore>).servesDeviceScopeLocally !== true) {
    throw new KVScopeViolationError(
      '@openmaic/storage: kvPersistStorage(store, "device") requires a store whose device scope ' +
        'stays local (servesDeviceScopeLocally) — a store that would send a device value over ' +
        'the wire cannot hold one',
    );
  }
  return {
    getItem: (name) => kv.get<PersistedValue<S>>(name, scope),
    setItem: (name, value) => kv.set(name, value, scope),
    removeItem: (name) => kv.remove(name, scope),
  };
}
