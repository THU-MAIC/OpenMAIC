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
 * with `await`". Four properties have to be established explicitly:
 *
 * - **Nothing persists until hydration has succeeded.** A failed read leaves
 *   the store at its defaults; if writes were allowed from there, the very next
 *   `set()` would persist those defaults over the user's real data. The check
 *   is made when `setItem` is *called*, not when its queued turn arrives —
 *   otherwise a write issued during hydration passes a gate that opened while
 *   it waited, and lands a pre-hydration snapshot on top of the stored value.
 * - **Reads and writes are serialized per key**, so concurrent writes cannot
 *   complete out of order and let an older value win.
 * - **Adoption is a distributed decision, not a local one.** A second tab (or a
 *   remote backend) can complete the migration between our two reads, so an
 *   apparent "nothing anywhere" is re-checked before it is believed.
 * - **Migration bookkeeping is device-local even when the data is not.** The
 *   sentinels below record what happened *on this machine* — that a raw
 *   `localStorage` entry was moved, that the pre-persist keys were consulted.
 *   Under an `account` backend that syncs, storing them beside the data would
 *   let one device's history authorize deleting another device's files.
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
import { reportPersistUnavailable } from '@/lib/store/persist-health';

const log = createLogger('KVPersist');

let defaultKv: KVStore | undefined;

/**
 * Sentinels are always `device`-scoped, whatever scope the store itself uses.
 *
 * Both record a fact about *this machine's* filesystem — "the raw entry here
 * was moved into KV", "the pre-persist keys here were consulted". An `account`
 * backend syncs across devices, so a sentinel stored there would travel to a
 * machine whose local files it says nothing about, and authorize deleting them.
 */
const SENTINEL_SCOPE: KVScope = 'device';

/**
 * Sentinel keys share the KV namespace with ordinary values, so they carry a
 * `__` prefix that no store name uses. Fully qualified, these land at
 * `maic:device:__persist-adopted:<name>` in the browser backend.
 */
const ADOPTED_PREFIX = '__persist-adopted:';
const PRE_PERSIST_PREFIX = '__pre-persist-consulted:';

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
   * itself, consulted at most once per device: only when neither the KV scope
   * nor the raw persist key holds anything *and* this device has no record of
   * having consulted it before.
   *
   * The once-per-device part is not belt-and-braces. Its source keys are
   * device-local and deliberately left in place, so without it, clearing the
   * `account` entry — from the cache button, or a server-side wipe — would let
   * any device re-read them and republish credentials the user had deleted.
   *
   * It must not delete what it reads: the caller owns those keys and may still
   * have other readers of them.
   */
  prePersistFallback?: () => StorageValue<S> | null;
  /**
   * Called the first time a write is refused because the key never hydrated.
   * The store wires this to its own `persist.rehydrate()`, so a backend that
   * has since recovered gets one chance to unblock persistence rather than
   * leaving the session silently read-only. If it does not recover, the seam
   * raises a durable user-facing notice through `persist-health`.
   */
  onWriteRefused?: (name: string) => void | Promise<unknown>;
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
 * The adoption is a move, not a copy: the KV write and its device-local
 * completion marker land before the raw entry is dropped, so an interrupted
 * migration leaves the value readable from one side or the other but never from
 * neither. It is idempotent — once KV holds the entry it is authoritative, so
 * re-running can neither duplicate nor resurrect state.
 *
 * On a read the backend could not answer, the raw entry is served read-only so
 * the store still hydrates with the user's data. Hydration therefore *resolves*
 * in that case and `hasHydrated` becomes true, which is deliberate: the store
 * does hold real data, and leaving hydration permanently pending would hang
 * every consumer that waits on it. What does not happen is persistence — see
 * `setItem`.
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
  let recoveryRequested = false;

  /**
   * One promise chain per key. `setItem` is fire-and-forget from zustand's
   * point of view, so without this two rapid writes race and the slower one can
   * land last; the same chain also keeps adoption from interleaving with an
   * ordinary write.
   *
   * Each link is appended to a noop-wrapped predecessor, so a task always runs
   * regardless of how the previous one settled — one failed write must not
   * wedge the key for the rest of the session.
   */
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(name: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(name) ?? Promise.resolve();
    const run = previous.then(task);
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

  // Sentinel access deliberately bypasses the per-key chain: these keys are
  // distinct from the store's own key, and every call site already holds the
  // chain for that key. Both intermediate states are safe — a marker written
  // with no KV entry only means a later read re-adopts, and a KV entry with no
  // marker only means a raw duplicate is kept rather than deleted.
  async function readSentinel(prefix: string, name: string): Promise<boolean> {
    const kv = resolveKv(deps);
    if (!kv) return false;
    try {
      return (await kv.get<true>(prefix + name, SENTINEL_SCOPE)) !== null;
    } catch (error) {
      log.error(`Could not read the "${prefix}${name}" sentinel:`, error);
      return false;
    }
  }

  async function writeSentinel(prefix: string, name: string): Promise<boolean> {
    const kv = resolveKv(deps);
    if (!kv) return false;
    try {
      await kv.set(prefix + name, true, SENTINEL_SCOPE);
      return true;
    } catch (error) {
      log.error(`Could not record the "${prefix}${name}" sentinel:`, error);
      return false;
    }
  }

  async function clearAdoptionMarker(name: string): Promise<void> {
    const kv = resolveKv(deps);
    if (!kv) return;
    try {
      await kv.remove(ADOPTED_PREFIX + name, SENTINEL_SCOPE);
    } catch (error) {
      log.warn(`Could not clear the adoption marker for "${name}":`, error);
    }
  }

  /**
   * Drop a raw entry that is shadowed by a KV entry — but only on proof that a
   * migration completed *on this device*.
   *
   * Without that proof the KV entry has unknown provenance, and the raw entry
   * may be the only copy of the user's real data. Keeping a shadowed duplicate
   * costs a few bytes; deleting the original costs the data.
   */
  async function dropShadowedLegacy(legacyStorage: Storage | null, name: string): Promise<void> {
    if (!hasLegacyEntry(legacyStorage, name)) return;
    if (!(await readSentinel(ADOPTED_PREFIX, name))) {
      log.warn(
        `"${name}" exists in the KV ${scope} scope and in localStorage, but this device has no ` +
          `record of completing that migration — keeping the localStorage copy`,
      );
      return;
    }
    dropLegacyEntry(legacyStorage, name);
  }

  /**
   * Move a value into the KV scope.
   *
   * `dropRaw` is false for the pre-persist fallback, and with it goes the
   * adoption marker: that marker is a licence to delete a raw persist entry,
   * and the fallback has not earned one. Were it written here, a raw entry
   * later restored by an older bundle or a rollback would be deleted unread.
   * The KV entry alone is enough to stop the fallback re-running.
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
    if (dropRaw) {
      if (!(await writeSentinel(ADOPTED_PREFIX, name))) return value;
      dropLegacyEntry(legacyStorage, name);
    }
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

        if (deps.prePersistFallback && !(await readSentinel(PRE_PERSIST_PREFIX, name))) {
          const prePersist = deps.prePersistFallback();
          if (prePersist !== null) {
            // One more read before committing. This narrows, but cannot close,
            // the window in which another device populated the scope while the
            // fallback was being assembled — `KVStore` has no compare-and-set.
            // Losing that race costs a redundant write of equivalent
            // pre-persist data, not a delete, so a narrower window is enough.
            const third = await readKv(kvStorage, name);
            if (third.ok && third.value !== null) {
              await dropShadowedLegacy(legacyStorage, name);
              settled.add(name);
              return third.value;
            }
            const value = await adopt(
              kvStorage,
              legacyStorage,
              name,
              prePersist,
              false,
              'the pre-persist keys',
            );
            if (settled.has(name)) await writeSentinel(PRE_PERSIST_PREFIX, name);
            return value;
          }
          await writeSentinel(PRE_PERSIST_PREFIX, name);
        }

        settled.add(name);
        return null;
      });
    },

    setItem(name, value) {
      // Evaluated here rather than inside the queued task on purpose. A write
      // issued while hydration is still in flight would otherwise wait its turn
      // behind `getItem`, find the gate open by the time it ran, and persist a
      // snapshot taken before hydration — overwriting the stored value with
      // defaults. The state of the world when the caller asked is what counts.
      if (!settled.has(name)) {
        // Every refusal is logged: this is silent data non-persistence, and a
        // once-per-session warning would hide how long it has been happening.
        log.error(
          `Refusing to persist "${name}": its storage has not hydrated successfully, so this ` +
            `write would overwrite the stored value with un-hydrated state. Changes made in ` +
            `this session are not being saved.`,
        );
        if (!recoveryRequested) {
          recoveryRequested = true;
          // The backend may have recovered since the failed read; give the
          // store one chance to hydrate properly and unblock persistence. If
          // the key is still unsettled afterwards, the user is told — silent
          // non-persistence is the one outcome worse than an error.
          void Promise.resolve()
            .then(() => deps.onWriteRefused?.(name))
            .then(
              () => {
                if (!settled.has(name)) reportPersistUnavailable(name);
              },
              () => reportPersistUnavailable(name),
            );
        }
        return Promise.resolve();
      }
      return serial(name, async () => {
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
        // thing to go. Failures propagate — a caller clearing a user's data
        // has to be able to tell that it did not happen.
        if (kvStorage) {
          await kvStorage.removeItem(name);
          await clearAdoptionMarker(name);
        }
        dropLegacyEntry(resolveLegacyStorage(deps), name);
        // The pre-persist sentinel is deliberately *not* cleared. It is
        // monotonic: its whole job is to stop the pre-persist keys, which are
        // still sitting on this device, from being republished after the KV
        // entry goes away — and clearing the entry is exactly that case.
      });
    },
  };
}
