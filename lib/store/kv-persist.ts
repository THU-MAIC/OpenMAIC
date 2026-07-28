/**
 * App wiring for zustand `persist` over the `@openmaic/storage` `KVStore`.
 *
 * Before this seam existed the persisted stores wrote straight to
 * `localStorage` through zustand's default storage, while the rest of the app's
 * small keyed values had already moved to `KVStore` — two unrelated mechanisms
 * over the same browser API, which is the split-brain the storage RFC set out
 * to remove. Routing `persist` through `KVStore` means one contract owns every
 * keyed value, so a server-backed deployment can serve the `account` scope
 * without the stores knowing.
 *
 * Scope is explicit per store and is not a backend detail: `device` values
 * never leave the machine under any backend, `account` values are user data a
 * server-backed deployment may sync across devices.
 *
 * Hydration becomes asynchronous, because a `KVStore` may be remote. In
 * practice the browser backend resolves within a few microtasks of the store
 * module being evaluated — well before React renders — but code that reads a
 * store in the same synchronous tick as its module evaluation now sees
 * defaults. Use `store.persist.onFinishHydration` / `store.persist.rehydrate()`
 * when that matters.
 */
import {
  BrowserKVStore,
  kvPersistStorage,
  type KVScope,
  type KVStore,
  type PersistStorageLike,
} from '@openmaic/storage';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

import { createLogger } from '@/lib/logger';

const log = createLogger('KVPersist');

let defaultKv: KVStore | undefined;

export interface KVPersistDeps {
  /** KV backend. Defaults to the shared browser (`localStorage`) backend. */
  kv?: KVStore;
  /**
   * Where zustand's default storage wrote this store before the cutover, read
   * once to adopt an existing install. Defaults to the ambient `localStorage`;
   * pass `null` to disable adoption (a store that never had a raw key).
   */
  legacyStorage?: Storage | null;
}

/**
 * `localStorage` is absent during SSR and throws outright under some privacy
 * settings; both mean "no browser storage here", not "crash the store".
 */
function ambientLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function resolveKv(deps: KVPersistDeps): KVStore | null {
  if (deps.kv) return deps.kv;
  if (!ambientLocalStorage()) return null;
  return (defaultKv ??= new BrowserKVStore());
}

function resolveLegacyStorage(deps: KVPersistDeps): Storage | null {
  return deps.legacyStorage !== undefined ? deps.legacyStorage : ambientLocalStorage();
}

function isStorageValue<S>(value: unknown): value is StorageValue<S> {
  return typeof value === 'object' && value !== null && 'state' in value;
}

/**
 * Read the pre-cutover raw entry, if it is one zustand could have written.
 *
 * Anything unreadable (not JSON, or not a `{ state }` envelope) is left exactly
 * where it is: we never delete bytes we could not interpret, and it is not ours
 * to adopt either.
 */
function readLegacy<S>(storage: Storage, name: string): StorageValue<S> | null {
  const raw = storage.getItem(name);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`Legacy "${name}" entry is not valid JSON; leaving it in place`);
    return null;
  }
  if (!isStorageValue<S>(parsed)) {
    log.warn(`Legacy "${name}" entry is not a persist envelope; leaving it in place`);
    return null;
  }
  return parsed;
}

/**
 * A zustand `PersistStorage` backed by `KVStore`, which adopts the store's
 * pre-cutover raw `localStorage` entry on first read.
 *
 * The adoption is a move, not a copy: the KV write lands before the raw entry
 * is dropped, so an interrupted migration leaves the value readable from one
 * side or the other but never from neither. It is idempotent — once KV holds
 * the entry it is authoritative and any raw entry still lying around is
 * discarded, so re-running can neither duplicate nor resurrect state.
 */
export function createKVPersistStorage<S>(
  scope: KVScope,
  deps: KVPersistDeps = {},
): PersistStorage<S> {
  // Resolved per call rather than once: the store module is evaluated during
  // SSR as well, where there is no storage to bind to yet.
  const resolveKvStorage = (): PersistStorageLike<S> | null => {
    const kv = resolveKv(deps);
    return kv ? kvPersistStorage<S>(kv, scope) : null;
  };

  return {
    async getItem(name) {
      const kvStorage = resolveKvStorage();
      if (!kvStorage) return null;

      const legacyStorage = resolveLegacyStorage(deps);
      const stored = await kvStorage.getItem(name);
      if (stored !== null) {
        // KV is authoritative; drop any raw entry so the two cannot diverge.
        legacyStorage?.removeItem(name);
        return stored;
      }

      if (!legacyStorage) return null;
      const adopted = readLegacy<S>(legacyStorage, name);
      if (adopted === null) return null;
      await kvStorage.setItem(name, adopted);
      legacyStorage.removeItem(name);
      log.info(`Migrated "${name}" from localStorage into the KV ${scope} scope`);
      return adopted;
    },

    async setItem(name, value) {
      await resolveKvStorage()?.setItem(name, value);
    },

    async removeItem(name) {
      // Clearing a store clears both homes, so a stale raw entry can never be
      // re-adopted after the user asked for it to be gone.
      resolveLegacyStorage(deps)?.removeItem(name);
      await resolveKvStorage()?.removeItem(name);
    },
  };
}
