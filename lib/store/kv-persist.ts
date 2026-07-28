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
 *
 * Everything below exists because "async storage" is not just "the same storage
 * with `await`". Three failure modes have to be closed explicitly:
 *
 * - **Nothing persists until hydration has succeeded.** A failed read leaves
 *   the store at its defaults; if writes were allowed from there, the very next
 *   `set()` would persist those defaults over the user's real data and the
 *   adoption below would then discard the original as a duplicate. Writes are
 *   refused until a read has actually settled the migration for that key.
 * - **Reads and writes are serialized per key.** Concurrent `setItem`s can
 *   otherwise complete out of order and let an older value win.
 * - **Adoption is a distributed decision, not a local one.** A second tab (or a
 *   remote backend) can complete the migration between our two reads, so an
 *   apparent "nothing anywhere" is re-checked before it is believed.
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

export interface KVPersistDeps<S> {
  /** KV backend. Defaults to the shared browser (`localStorage`) backend. */
  kv?: KVStore;
  /**
   * Where zustand's default storage wrote this store before the cutover, read
   * once to adopt an existing install. Defaults to the ambient `localStorage`;
   * pass `null` to disable adoption (a store that never had a raw key).
   */
  legacyStorage?: Storage | null;
  /**
   * Last-resort source for a store whose data predates the persist middleware
   * itself, consulted only when neither the KV scope nor the raw persist key
   * holds anything. Its result is adopted into the KV scope like any other
   * migration, so the KV entry becomes the one-time marker that stops it from
   * running again — which is the only reliable way to keep a pre-persist
   * migration from resurrecting on every load once its old sentinel is gone.
   *
   * It must not delete what it reads: the caller owns those keys and may still
   * have other readers of them.
   */
  prePersistFallback?: () => StorageValue<S> | null;
}

/** Where the "this key's migration completed" flag lives, in the same scope. */
function adoptionMarkerKey(name: string): string {
  return `persist-adopted:${name}`;
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

function resolveKv<S>(deps: KVPersistDeps<S>): KVStore | null {
  if (deps.kv) return deps.kv;
  if (!ambientLocalStorage()) return null;
  return (defaultKv ??= new BrowserKVStore());
}

function resolveLegacyStorage<S>(deps: KVPersistDeps<S>): Storage | null {
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
function readLegacy<S>(storage: Storage | null, name: string): StorageValue<S> | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(name);
  } catch (error) {
    log.warn(`Could not read the legacy "${name}" entry:`, error);
    return null;
  }
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

function hasLegacyEntry(storage: Storage | null, name: string): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(name) !== null;
  } catch {
    return false;
  }
}

function dropLegacyEntry(storage: Storage | null, name: string): void {
  try {
    storage?.removeItem(name);
  } catch (error) {
    log.warn(`Could not drop the legacy "${name}" entry:`, error);
  }
}

/**
 * A KV read that distinguishes "there is nothing there" from "the backend could
 * not answer". Conflating the two is what turns one bad read into data loss:
 * an unavailable backend must never look like an empty one.
 */
type ReadResult<T> = { ok: true; value: T | null } | { ok: false };

/**
 * A zustand `PersistStorage` backed by `KVStore`, which adopts the store's
 * pre-cutover raw `localStorage` entry on first read.
 *
 * The adoption is a move, not a copy: the KV write and its completion marker
 * land before the raw entry is dropped, so an interrupted migration leaves the
 * value readable from one side or the other but never from neither. It is
 * idempotent — once KV holds the entry it is authoritative, so re-running can
 * neither duplicate nor resurrect state.
 */
export function createKVPersistStorage<S>(
  scope: KVScope,
  deps: KVPersistDeps<S> = {},
): PersistStorage<S> {
  // Resolved per call rather than once: the store module is evaluated during
  // SSR as well, where there is no storage to bind to yet.
  const resolveKvStorage = (): PersistStorageLike<S> | null => {
    const kv = resolveKv(deps);
    return kv ? kvPersistStorage<S>(kv, scope) : null;
  };

  /**
   * Names whose migration has been settled by a successful read this session.
   * Until a name is in here nothing may be written for it — see the header.
   */
  const settled = new Set<string>();
  const warnedUnsettled = new Set<string>();

  /**
   * One promise chain per key. `setItem` is fire-and-forget from zustand's
   * point of view, so without this two rapid writes race and the slower one
   * can land last; the same chain also keeps adoption from interleaving with
   * an ordinary write.
   */
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(name) ?? Promise.resolve();
    // `task` runs whether or not the previous link settled — one failed write
    // must not wedge the key for the rest of the session.
    const run = previous.then(task, task);
    queues.set(
      name,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async function readKv(
    kvStorage: PersistStorageLike<S>,
    name: string,
  ): Promise<ReadResult<StorageValue<S>>> {
    try {
      return { ok: true, value: await kvStorage.getItem(name) };
    } catch (error) {
      // The browser backend `JSON.parse`s on read, so a corrupt entry throws
      // here rather than returning null.
      log.error(`Could not read "${name}" from the KV ${scope} scope:`, error);
      return { ok: false };
    }
  }

  async function writeKv(
    kvStorage: PersistStorageLike<S>,
    name: string,
    value: StorageValue<S>,
  ): Promise<boolean> {
    try {
      await kvStorage.setItem(name, value);
      return true;
    } catch (error) {
      // Loud on purpose: a silent write failure is how a store looks saved and
      // is not. The caller leaves the pre-cutover entry alone when this fails.
      log.error(`Could not write "${name}" to the KV ${scope} scope:`, error);
      return false;
    }
  }

  async function isAdoptionMarked(name: string): Promise<boolean> {
    const kv = resolveKv(deps);
    if (!kv) return false;
    try {
      return (await kv.get<true>(adoptionMarkerKey(name), scope)) !== null;
    } catch (error) {
      log.error(`Could not read the adoption marker for "${name}":`, error);
      return false;
    }
  }

  async function markAdopted(name: string): Promise<boolean> {
    const kv = resolveKv(deps);
    if (!kv) return false;
    try {
      await kv.set(adoptionMarkerKey(name), true, scope);
      return true;
    } catch (error) {
      log.error(`Could not record the adoption marker for "${name}":`, error);
      return false;
    }
  }

  async function clearAdoptionMarker(name: string): Promise<void> {
    const kv = resolveKv(deps);
    if (!kv) return;
    try {
      await kv.remove(adoptionMarkerKey(name), scope);
    } catch (error) {
      log.warn(`Could not clear the adoption marker for "${name}":`, error);
    }
  }

  /**
   * Drop a raw entry that is shadowed by a KV entry — but only on proof that a
   * migration for this key ever completed.
   *
   * Without that proof the KV entry has unknown provenance, and the raw entry
   * may be the only copy of the user's real data. Keeping a shadowed duplicate
   * costs a few bytes; deleting the original costs the data.
   */
  async function dropShadowedLegacy(legacyStorage: Storage | null, name: string): Promise<void> {
    if (!hasLegacyEntry(legacyStorage, name)) return;
    if (!(await isAdoptionMarked(name))) {
      log.warn(
        `"${name}" exists in the KV ${scope} scope and in localStorage, but no completed ` +
          `migration is recorded — keeping the localStorage copy rather than assuming it is stale`,
      );
      return;
    }
    dropLegacyEntry(legacyStorage, name);
  }

  /**
   * Move a value into the KV scope. `dropRaw` is false for the pre-persist
   * fallback, whose source keys have other readers and are not ours to delete.
   */
  async function adopt(
    kvStorage: PersistStorageLike<S>,
    legacyStorage: Storage | null,
    name: string,
    value: StorageValue<S>,
    dropRaw: boolean,
    source: string,
  ): Promise<StorageValue<S>> {
    if (!(await writeKv(kvStorage, name, value))) return value;
    if (!(await markAdopted(name))) return value;
    if (dropRaw) dropLegacyEntry(legacyStorage, name);
    settled.add(name);
    log.info(`Migrated "${name}" from ${source} into the KV ${scope} scope`);
    return value;
  }

  return {
    getItem(name) {
      return serial(name, async () => {
        const kvStorage = resolveKvStorage();
        if (!kvStorage) return null;
        const legacyStorage = resolveLegacyStorage(deps);

        const first = await readKv(kvStorage, name);
        if (!first.ok) {
          // The backend could not answer. Serve the raw entry so the store
          // still hydrates with the user's data, but adopt nothing, delete
          // nothing, and leave the key unsettled so no write can persist over
          // an original we were unable to read.
          return readLegacy<S>(legacyStorage, name);
        }

        if (first.value !== null) {
          await dropShadowedLegacy(legacyStorage, name);
          settled.add(name);
          return first.value;
        }

        const adopted = readLegacy<S>(legacyStorage, name);
        if (adopted !== null) {
          return await adopt(kvStorage, legacyStorage, name, adopted, true, 'localStorage');
        }

        // Empty KV *and* no raw entry is also exactly what another tab's
        // in-flight adoption looks like from here: it has written the KV entry
        // and removed the raw one somewhere between our two reads. Under a
        // remote backend this is ordinary, not a rare interleaving, so confirm
        // before concluding there is nothing to load.
        const second = await readKv(kvStorage, name);
        if (!second.ok) return null;
        if (second.value !== null) {
          await dropShadowedLegacy(legacyStorage, name);
          settled.add(name);
          return second.value;
        }

        const prePersist = deps.prePersistFallback?.() ?? null;
        if (prePersist !== null) {
          return await adopt(
            kvStorage,
            legacyStorage,
            name,
            prePersist,
            false,
            'the pre-persist keys',
          );
        }

        settled.add(name);
        return null;
      });
    },

    setItem(name, value) {
      return serial(name, async () => {
        if (!settled.has(name)) {
          // The store is sitting on defaults (or on data we served read-only
          // from localStorage) because hydration never completed. Persisting
          // from here would overwrite the real value with a placeholder and
          // then look, on the next load, exactly like a legitimately migrated
          // store. Refuse instead.
          if (!warnedUnsettled.has(name)) {
            warnedUnsettled.add(name);
            log.error(
              `Refusing to persist "${name}": its storage never hydrated successfully, so this ` +
                `write would overwrite the stored value with un-hydrated state`,
            );
          }
          return;
        }
        const kvStorage = resolveKvStorage();
        if (!kvStorage) return;
        await writeKv(kvStorage, name, value);
      });
    },

    removeItem(name) {
      return serial(name, async () => {
        const kvStorage = resolveKvStorage();
        // KV copy first, raw entry last: the raw entry predates this seam and
        // is the only copy nothing else can reconstruct, so it is the last
        // thing to go. Clearing the marker with it puts the key back in the
        // un-migrated state a fresh install would be in.
        if (kvStorage) {
          try {
            await kvStorage.removeItem(name);
          } catch (error) {
            log.error(`Could not remove "${name}" from the KV ${scope} scope:`, error);
            return;
          }
          await clearAdoptionMarker(name);
        }
        dropLegacyEntry(resolveLegacyStorage(deps), name);
      });
    },
  };
}
