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
 * ## Why this file is shaped like a state machine
 *
 * Asynchronous storage fails in ways `localStorage` never did, and successive
 * review rounds kept finding the same two bugs in new clothes: a backend
 * failure read as "there is nothing there", and the result of an operation that
 * nobody looked at. Both are only possible while a call site is free to decide
 * for itself what a failed operation meant.
 *
 * So call sites are not free to. Every backend call returns an {@link Outcome}
 * whose payload is a private field and whose only reader, {@link Outcome.into},
 * demands a {@link KeyState}. Feeding the machine is not a convention to
 * remember; it is the only way to get the value out. The machine then decides,
 * in one place, what failure means: a failed read is never absence, a failed
 * write never leaves a key writable, and either raises the health signal and
 * asks for recovery.
 *
 * The states and transitions are tabulated on {@link KeyState}.
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
import { reportPersistHealth } from '@/lib/store/persist-health';

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

/** What a backend operation yields when the backend could not answer. */
const UNAVAILABLE = Symbol('kv-unavailable');
type Unavailable = typeof UNAVAILABLE;

/**
 * The result of one backend operation, sealed.
 *
 * The payload is a true private field and {@link Outcome.into} is its only
 * reader, so no call site can inspect whether an operation succeeded without
 * first handing it to the state machine — which is where the meaning of failure
 * is decided. What comes back is either the value or {@link UNAVAILABLE}, and
 * `UNAVAILABLE` is deliberately not `null`: "the backend could not answer" must
 * not be spellable as "there is nothing there".
 */
class Outcome<T> {
  readonly #result: { ok: true; value: T } | { ok: false; error: unknown };

  private constructor(result: { ok: true; value: T } | { ok: false; error: unknown }) {
    this.#result = result;
  }

  /** Run a backend operation, capturing a throw rather than propagating it. */
  static async run<T>(work: () => Promise<T>): Promise<Outcome<T>> {
    try {
      return new Outcome<T>({ ok: true, value: await work() });
    } catch (error) {
      return new Outcome<T>({ ok: false, error });
    }
  }

  /** An already-known value, for paths with no backend to call. */
  static resolved<T>(value: T): Outcome<T> {
    return new Outcome<T>({ ok: true, value });
  }

  /**
   * Open the outcome through the state machine. A failure is recorded against
   * the key — unsettling it, raising the health signal and scheduling recovery
   * — before `UNAVAILABLE` is handed back.
   */
  into(state: KeyState<unknown>, operation: string): T | Unavailable {
    if (this.#result.ok) return this.#result.value;
    state.onFailure(operation, this.#result.error);
    return UNAVAILABLE;
  }
}

type KeyPhase = 'unhydrated' | 'settled' | 'unavailable' | 'clearing';

interface KeyStateHooks {
  /** Ask the store to rehydrate; the backend may have recovered. */
  requestRecovery: (name: string) => void;
}

/** A write that was refused or rejected, kept in case recovery can replay it. */
interface RefusedWrite<S> {
  value: StorageValue<S>;
  /**
   * Whether replaying this is safe, which turns on one question: was the store
   * holding the *authoritative* value when the write was taken?
   *
   * Only a value the KV scope actually returned counts. The raw entry served
   * read-only after a failed read does not: a shadowed raw entry is by
   * construction the older copy — long-term coexistence with a newer KV value
   * is a designed state, not an anomaly — so a snapshot built on it would roll
   * the account back if it were written. Nor do defaults, for the obvious
   * reason. Replaying either is the very failure this seam exists to prevent.
   */
  replayable: boolean;
  /**
   * The phase the write was refused in. A refusal under `unavailable` means
   * storage genuinely broke and the user needs telling; a refusal under
   * `unhydrated` is ordinary cold-start timing — an initializer writing before
   * the first read resolved — and warrants a log line, not an alarm.
   */
  origin: KeyPhase;
}

/**
 * Per-key state machine. One instance per persist key, per adapter.
 *
 * ```text
 * state        event           -> next state   actions
 * ------------ --------------- -------------- --------------------------------
 * unhydrated   settle          -> settled      replay or report refused write
 * unhydrated   failure         -> unavailable  log, health signal, recovery
 * unhydrated   write           -> unhydrated   refuse, remember, log, recovery
 * unhydrated   clearRequested  -> clearing     discard refused write
 * settled      settle          -> settled      replay or report refused write
 * settled      failure         -> unavailable  log, health signal, recovery
 * settled      write           -> settled      admit
 * settled      writeFailed     -> unavailable  remember the write, log, signal,
 *                                              recovery
 * settled      clearRequested  -> clearing     discard refused write
 * unavailable  settle          -> settled      replay or report refused write
 * unavailable  failure         -> unavailable  log only (already signalled)
 * unavailable  write           -> unavailable  refuse, remember, log, recovery
 * unavailable  clearRequested  -> clearing     discard refused write
 * clearing     settle          -> clearing     discard refused write (a read
 *                                              finishing mid-clear must not
 *                                              open the gate)
 * clearing     clearFinished   -> settled      -
 * clearing     failure         -> unavailable  log, health signal, recovery
 * clearing     write           -> clearing     refuse, log
 * clearing     clearRequested  -> clearing     discard refused write
 * ```
 *
 * A remembered write is replayed on the next `settle` only if the last read had
 * served the store real data; see {@link RefusedWrite}. Otherwise the user is
 * told, because rehydration is about to discard those edits.
 *
 * Two rows carry most of the weight. `clearing` is entered *synchronously* when
 * `removeItem` is called, so a `set()` racing a clear cannot be admitted, queue
 * behind the delete, and write the just-deleted value back. And
 * `clearFinished` reaches `settled` without replaying anything — the user asked
 * for that data to be gone.
 */
class KeyState<S> {
  #phase: KeyPhase = 'unhydrated';
  #storeHoldsRealData = false;
  #refused: RefusedWrite<S> | null = null;
  #replay: StorageValue<S> | null = null;
  #recoveryAsked = false;

  constructor(
    private readonly name: string,
    private readonly hooks: KeyStateHooks,
  ) {}

  get phase(): KeyPhase {
    return this.#phase;
  }

  /**
   * A backend operation failed. Every failure means the same thing, whichever
   * operation it was: the key's stored state is no longer something this
   * session can reason about, so it must not be written over and the user has
   * to be told.
   */
  onFailure(operation: string, error: unknown): void {
    log.error(`Could not ${operation}:`, error);
    if (this.#phase === 'unavailable') return;
    this.#phase = 'unavailable';
    reportPersistHealth(this.name, 'unavailable');
    this.#askForRecovery();
  }

  /** A read path concluded, with every sentinel it needed durably written. */
  settle(): void {
    if (this.#phase === 'clearing') {
      // A read that finishes mid-clear says nothing about the clear. Opening
      // the gate here would admit a write that then queues behind the pending
      // delete and puts the just-deleted value straight back — and under a
      // remote backend a recovery rehydrate being in flight during a clear is
      // ordinary, not a corner case. Only `finishClear` opens this key.
      this.#refused = null;
      this.#replay = null;
      return;
    }

    this.#phase = 'settled';
    // Storage answered, so the next failure deserves its own recovery attempt.
    this.#recoveryAsked = false;

    const refused = this.#refused;
    this.#refused = null;
    if (refused === null) {
      // Storage works again and nothing was owed, so retract any standing
      // notice. Deferred publishing means a recovery this quick usually
      // cancels the warning before anyone sees it.
      reportPersistHealth(this.name, 'recovered');
      return;
    }

    if (refused.replayable) {
      // Handed back through `takeReplay`, so the recovering read returns it and
      // storage and the store agree on the user's newest value rather than
      // diverging.
      this.#replay = refused.value;
      log.info(`Replaying the write that was refused for "${this.name}"`);
      reportPersistHealth(this.name, 'recovered');
      return;
    }
    // Nothing safe to write back. Rehydration is about to replace whatever was
    // in memory with the stored value.
    if (refused.origin !== 'unavailable') {
      // Ordinary cold-start timing: something wrote before the first read
      // resolved, on a backend that never failed. Worth a log line, but
      // alarming the user about a healthy app would be worse than saying
      // nothing. The architectural fix is a hydration gate the app consumes.
      log.warn(
        `A write to "${this.name}" issued before its storage hydrated was dropped; the stored ` +
          `value stands`,
      );
      reportPersistHealth(this.name, 'recovered');
      return;
    }
    log.error(
      `Changes to "${this.name}" made while its storage was unavailable could not be saved, and ` +
        `have been replaced by the stored value`,
    );
    reportPersistHealth(this.name, 'changes-lost');
  }

  /** `removeItem` was called. Synchronous by design — see the table. */
  beginClear(): void {
    this.#phase = 'clearing';
    // A clear is an instruction to forget. Replaying a write from before it
    // would resurrect precisely what the user asked to delete.
    this.#refused = null;
    this.#replay = null;
  }

  /** The clear completed: the key is known again, and known to be empty. */
  finishClear(): void {
    this.#phase = 'settled';
    this.#recoveryAsked = false;
    // Belt and braces against a future path that remembers a write mid-clear:
    // nothing from before a deletion may survive it.
    this.#refused = null;
    this.#replay = null;
    reportPersistHealth(this.name, 'recovered');
  }

  /**
   * Decide a write at the moment it is issued, never when its queued turn
   * arrives: a write issued during hydration would otherwise wait behind the
   * read, find the gate opened by the very read it raced, and persist its
   * pre-hydration snapshot over the stored value.
   */
  admitWrite(value: StorageValue<S>): boolean {
    if (this.#phase === 'settled') return true;

    // A write refused *during a clear* is not remembered. The user asked for
    // this data to be gone; holding on to a snapshot of it only creates a way
    // for it to come back.
    if (this.#phase !== 'clearing') {
      this.#refused = { value, replayable: this.#storeHoldsRealData, origin: this.#phase };
    }
    // Every refusal, not only the first: a once-per-session warning hides how
    // long a session has been silently going unsaved.
    log.error(
      `Refusing to persist "${this.name}" while its storage is ${this.#phase}. Changes made in ` +
        `this session are not being saved.`,
    );
    if (this.#phase !== 'clearing') this.#askForRecovery();
    return false;
  }

  /**
   * Record that the store now holds the authoritative persisted value rather
   * than defaults or a shadowed copy — because the KV scope returned it.
   *
   * Latches on and never off: once a session has had the real value in hand,
   * every later snapshot is built on it. This is what decides whether a write
   * the backend rejected can be replayed — see {@link RefusedWrite}.
   */
  noteRealData(): void {
    this.#storeHoldsRealData = true;
  }

  /**
   * A write was admitted and the backend then rejected it. Remember it exactly
   * as a refused write would be: it is the newest copy of the user's data and
   * the only place it still exists is memory.
   */
  noteWriteFailed(value: StorageValue<S>): void {
    this.#refused = { value, replayable: this.#storeHoldsRealData, origin: this.#phase };
  }

  /**
   * A write landed. Anything remembered from an earlier failed write is now
   * stale: both were admitted before the key closed, so the queue ordered them,
   * and replaying the older one later would undo this newer value.
   */
  noteWriteSucceeded(): void {
    this.#storeHoldsRealData = true;
    this.#refused = null;
    this.#replay = null;
  }

  /** The value a recovering read should return in place of what it found. */
  takeReplay(): StorageValue<S> | null {
    const replay = this.#replay;
    this.#replay = null;
    return replay;
  }

  #askForRecovery(): void {
    if (this.#recoveryAsked) return;
    this.#recoveryAsked = true;
    this.hooks.requestRecovery(this.name);
  }
}

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
   * having consulted it before. Every path that settles a key records that, so
   * "this device has already dealt with the pre-persist keys" holds after any
   * successful load, not only after the fallback itself runs.
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
   * Called once per key when it needs its store to rehydrate: a write was
   * refused, or the backend failed. The store wires this to
   * `persist.rehydrate()`, so a backend that has since recovered gets a chance
   * to unblock persistence rather than leaving the session silently read-only.
   */
  onWriteRefused?: (name: string) => void | Promise<unknown>;
}

/**
 * `localStorage` is absent during SSR and throws outright under some privacy
 * settings; both mean "no browser storage here", not "crash the store".
 */
function isBrowserRuntime(): boolean {
  return typeof window !== 'undefined';
}

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
function readLegacy<S>(
  state: KeyState<unknown>,
  storage: Storage | null,
  name: string,
): StorageValue<S> | null | Unavailable {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(name);
  } catch (error) {
    // `localStorage` throws outright in some privacy modes. That is the backend
    // failing to answer, not the entry being absent — and reading it as absence
    // is how a raw entry gets adopted-over or deleted while still holding data.
    state.onFailure(`read the legacy "${name}" entry`, error);
    return UNAVAILABLE;
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

function dropLegacyEntry(storage: Storage | null, name: string): void {
  try {
    storage?.removeItem(name);
  } catch (error) {
    log.warn(`Could not drop the legacy "${name}" entry:`, error);
  }
}

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
 * and `hasHydrated` becomes true, which is deliberate: the store does hold real
 * data, and leaving hydration permanently pending would hang every consumer
 * that waits on it. What protects the stored value is the write gate, not the
 * hydration flag.
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

  const states = new Map<string, KeyState<S>>();
  function stateFor(name: string): KeyState<S> {
    let state = states.get(name);
    if (!state) {
      state = new KeyState<S>(name, {
        // Deferred: recovery usually calls back into `persist.rehydrate()`,
        // and running that inside a `setItem` call would re-enter the store
        // mid-update. A recovery that throws is just a recovery that did not
        // work — the key stays unavailable and its notice stands, so there is
        // nothing to do but say what happened.
        requestRecovery: (key) => {
          void Promise.resolve()
            .then(() => deps.onWriteRefused?.(key))
            .catch((error) => log.error(`Recovery attempt for "${key}" failed:`, error));
        },
      });
      states.set(name, state);
    }
    return state;
  }

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

  // Sentinel access deliberately bypasses the per-key chain: these keys are
  // distinct from the store's own key, and every call site already holds the
  // chain for that key. Both intermediate states are safe — a sentinel written
  // with no KV entry only means a later read re-adopts, and a KV entry with no
  // sentinel only means a raw duplicate is kept rather than deleted.
  function readSentinel(prefix: string, name: string): Promise<Outcome<boolean>> {
    const kv = resolveKv(deps);
    if (!kv) return Promise.resolve(Outcome.resolved(false));
    return Outcome.run(async () => (await kv.get<true>(prefix + name, SENTINEL_SCOPE)) !== null);
  }

  function writeSentinel(prefix: string, name: string): Promise<Outcome<void>> {
    const kv = resolveKv(deps);
    if (!kv) return Promise.resolve(Outcome.resolved(undefined));
    return Outcome.run(() => kv.set(prefix + name, true, SENTINEL_SCOPE));
  }

  function clearAdoptionMarker(name: string): Promise<Outcome<void>> {
    const kv = resolveKv(deps);
    if (!kv) return Promise.resolve(Outcome.resolved(undefined));
    return Outcome.run(() => kv.remove(ADOPTED_PREFIX + name, SENTINEL_SCOPE));
  }

  /**
   * Record, once per device, that the pre-persist keys have been dealt with.
   *
   * Written on *every* settling path, not only the one that consults them.
   * Otherwise a device that has only ever loaded an already-populated `account`
   * entry records nothing, and republishes its own decade-old keys the first
   * time that entry is cleared.
   */
  async function recordPrePersistHandled(state: KeyState<S>, name: string): Promise<boolean> {
    if (!deps.prePersistFallback) return true;
    const already = (await readSentinel(PRE_PERSIST_PREFIX, name)).into(
      state,
      `read the pre-persist sentinel for "${name}"`,
    );
    if (already === UNAVAILABLE) return false;
    if (already) return true;
    const written = (await writeSentinel(PRE_PERSIST_PREFIX, name)).into(
      state,
      `record the pre-persist sentinel for "${name}"`,
    );
    return written !== UNAVAILABLE;
  }

  /**
   * Conclude a read: record the pre-persist sentinel, then settle. A sentinel
   * that did not land leaves the key *unsettled* — the read is retried on the
   * next load rather than leaving this device holding a promise it cannot keep.
   */
  async function concludeRead(
    state: KeyState<S>,
    name: string,
    value: StorageValue<S> | null,
  ): Promise<StorageValue<S> | null> {
    if (!(await recordPrePersistHandled(state, name))) return value;
    state.settle();

    const replay = state.takeReplay();
    if (replay === null) return value;
    // A write refused while the backend was down, taken against real hydrated
    // data. Persisted here rather than left to the store to write back: it goes
    // through the same gate as any other write, and returning it too means the
    // store and storage agree on the user's newest value instead of the read
    // handing back a value it has just superseded.
    if (!state.admitWrite(replay)) return value;
    const kvStorage = resolveKvStorage();
    if (kvStorage) {
      (await Outcome.run(() => kvStorage.setItem(name, replay))).into(
        state,
        `replay the refused write for "${name}" to the KV ${scope} scope`,
      );
    }
    return replay;
  }

  /**
   * Drop a raw entry shadowed by a KV entry — but only on proof that a
   * migration completed *on this device*, and only if the bytes are ones this
   * seam could have written.
   *
   * Without that proof the KV entry has unknown provenance, and the raw entry
   * may be the only copy of the user's real data. Keeping a shadowed duplicate
   * costs a few bytes; deleting the original costs the data.
   */
  async function dropShadowedLegacy(
    state: KeyState<S>,
    legacyStorage: Storage | null,
    name: string,
  ): Promise<void> {
    // Unreadable bytes are never deleted, here as anywhere else: a marker says
    // *a* migration happened, not that these particular bytes were understood.
    // An unreadable *storage* is likewise no basis for deleting anything.
    const shadowed = readLegacy<S>(state, legacyStorage, name);
    if (shadowed === null || shadowed === UNAVAILABLE) return;
    const marked = (await readSentinel(ADOPTED_PREFIX, name)).into(
      state,
      `read the adoption marker for "${name}"`,
    );
    if (marked === UNAVAILABLE) return;
    if (!marked) {
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
   * and the fallback has earned no such thing. Were it written here, a raw
   * entry later restored by an older bundle or a rollback would be deleted
   * unread. The KV entry alone is enough to stop the fallback re-running.
   */
  async function adopt(
    state: KeyState<S>,
    kvStorage: PersistStorageLike<S>,
    legacyStorage: Storage | null,
    name: string,
    value: StorageValue<S>,
    dropRaw: boolean,
    source: string,
  ): Promise<StorageValue<S> | null> {
    // One last look before committing. Another tab may have written something
    // newer while this migration was being assembled; `KVStore` has no
    // compare-and-set, so this narrows the window rather than closing it.
    // Losing the race costs a redundant write of equivalent data, not a delete.
    const current = (await Outcome.run(() => kvStorage.getItem(name))).into(
      state,
      `re-read "${name}" from the KV ${scope} scope`,
    );
    if (current === UNAVAILABLE) return value;
    if (current !== null) {
      await dropShadowedLegacy(state, legacyStorage, name);
      return concludeRead(state, name, current);
    }

    const written = (await Outcome.run(() => kvStorage.setItem(name, value))).into(
      state,
      `write "${name}" to the KV ${scope} scope`,
    );
    if (written === UNAVAILABLE) return value;

    if (dropRaw) {
      const marked = (await writeSentinel(ADOPTED_PREFIX, name)).into(
        state,
        `record the adoption marker for "${name}"`,
      );
      // No durable marker means no licence to delete: leave the raw entry and
      // let the next load try the migration again.
      if (marked === UNAVAILABLE) return value;
      dropLegacyEntry(legacyStorage, name);
    }

    log.info(`Migrated "${name}" from ${source} into the KV ${scope} scope`);
    return concludeRead(state, name, value);
  }

  return {
    getItem(name) {
      const state = stateFor(name);
      return serial(name, async () => {
        // Every exit reports what the store is about to receive, so the
        // machine knows whether a later refused write stands on the
        // authoritative value or on something older.
        const served = await load();
        if (served.value !== null && !served.provisional) state.noteRealData();
        return served.value;
      });

      /**
       * `provisional` marks a value the KV scope did not vouch for — the raw
       * entry served after a failed read. It hydrates the store, but it is by
       * construction the older copy, so nothing may be replayed on top of it.
       */
      async function load(): Promise<{ value: StorageValue<S> | null; provisional?: boolean }> {
        const kvStorage = resolveKvStorage();
        if (!kvStorage) {
          // No storage during SSR is expected and silent. In a browser it is a
          // failure — privacy modes make `localStorage` unreachable — and
          // treating it as an empty store means every write is refused with
          // nothing said until the user reloads and finds their work gone.
          if (isBrowserRuntime()) {
            state.onFailure(
              'reach browser storage',
              new Error('localStorage is unavailable in this browser context'),
            );
          }
          return { value: null };
        }
        const legacyStorage = resolveLegacyStorage(deps);

        const stored = (await Outcome.run(() => kvStorage.getItem(name))).into(
          state,
          `read "${name}" from the KV ${scope} scope`,
        );
        if (stored === UNAVAILABLE) {
          // Serve the raw entry so the store still hydrates with the user's
          // data, but adopt nothing, delete nothing, and leave the key
          // unsettled so no write can persist over an original we were unable
          // to read.
          const fallback = readLegacy<S>(state, legacyStorage, name);
          return { value: fallback === UNAVAILABLE ? null : fallback, provisional: true };
        }

        if (stored !== null) {
          await dropShadowedLegacy(state, legacyStorage, name);
          return { value: await concludeRead(state, name, stored) };
        }

        const adopted = readLegacy<S>(state, legacyStorage, name);
        if (adopted === UNAVAILABLE) return { value: null };
        if (adopted !== null) {
          return {
            value: await adopt(
              state,
              kvStorage,
              legacyStorage,
              name,
              adopted,
              true,
              'localStorage',
            ),
          };
        }

        // Empty KV *and* no raw entry is also exactly what another tab's
        // in-flight adoption looks like from here: it has written the KV entry
        // and removed the raw one somewhere between our two reads. Under a
        // remote backend this is ordinary, not a rare interleaving, so confirm
        // before concluding there is nothing to load.
        const confirmed = (await Outcome.run(() => kvStorage.getItem(name))).into(
          state,
          `re-read "${name}" from the KV ${scope} scope`,
        );
        if (confirmed === UNAVAILABLE) return { value: null };
        if (confirmed !== null) {
          await dropShadowedLegacy(state, legacyStorage, name);
          return { value: await concludeRead(state, name, confirmed) };
        }

        if (deps.prePersistFallback) {
          const consulted = (await readSentinel(PRE_PERSIST_PREFIX, name)).into(
            state,
            `read the pre-persist sentinel for "${name}"`,
          );
          if (consulted === UNAVAILABLE) return { value: null };
          if (!consulted) {
            // App-supplied and synchronous: a throw here is the app's, not the
            // backend's, but it must not escape into zustand's silent catch.
            const prePersist = (
              await Outcome.run(async () => deps.prePersistFallback?.() ?? null)
            ).into(state, `read the pre-persist source keys for "${name}"`);
            if (prePersist === UNAVAILABLE) return { value: null };
            if (prePersist !== null) {
              return {
                value: await adopt(
                  state,
                  kvStorage,
                  legacyStorage,
                  name,
                  prePersist,
                  false,
                  'the pre-persist keys',
                ),
              };
            }
          }
        }

        return { value: await concludeRead(state, name, null) };
      }
    },

    setItem(name, value) {
      const state = stateFor(name);
      if (!state.admitWrite(value)) return Promise.resolve();
      return serial(name, async () => {
        const kvStorage = resolveKvStorage();
        if (!kvStorage) {
          if (isBrowserRuntime()) {
            state.onFailure(
              'reach browser storage',
              new Error('localStorage is unavailable in this browser context'),
            );
          }
          return;
        }
        // The outcome goes to the machine like any other: a write that fails
        // after the key settled leaves it unwritable and signalled, rather than
        // reporting a success nobody checked.
        const written = (await Outcome.run(() => kvStorage.setItem(name, value))).into(
          state,
          `write "${name}" to the KV ${scope} scope`,
        );
        if (written === UNAVAILABLE) state.noteWriteFailed(value);
        else state.noteWriteSucceeded();
      });
    },

    removeItem(name) {
      const state = stateFor(name);
      // Synchronously, before queuing: a `set()` issued while the delete is in
      // flight would otherwise be admitted, queue behind it, and write the
      // just-deleted value straight back.
      state.beginClear();
      return serial(name, async () => {
        const kvStorage = resolveKvStorage();
        // KV copy first, raw entry last: the raw entry predates this seam and
        // is the only copy nothing else can reconstruct, so it is the last
        // thing to go. Failures propagate — a caller clearing a user's data has
        // to be able to tell that it did not happen.
        if (kvStorage) {
          const removed = (await Outcome.run(() => kvStorage.removeItem(name))).into(
            state,
            `remove "${name}" from the KV ${scope} scope`,
          );
          if (removed === UNAVAILABLE) {
            throw new Error(`Could not remove ${JSON.stringify(name)} from the KV ${scope} scope`);
          }
          // Raw entry before the marker: with the raw entry already gone, a
          // failure to clear the marker leaves a sentinel that authorizes
          // deleting a file that no longer exists, which is inert. The other
          // order leaves a raw entry with no marker to retire it.
          dropLegacyEntry(resolveLegacyStorage(deps), name);
          const cleared = (await clearAdoptionMarker(name)).into(
            state,
            `clear the adoption marker for "${name}"`,
          );
          if (cleared === UNAVAILABLE) {
            throw new Error(`Could not clear the adoption marker for ${JSON.stringify(name)}`);
          }
        } else {
          if (isBrowserRuntime()) {
            state.onFailure(
              'reach browser storage',
              new Error('localStorage is unavailable in this browser context'),
            );
            throw new Error(`Could not clear ${JSON.stringify(name)}: storage is unreachable`);
          }
          dropLegacyEntry(resolveLegacyStorage(deps), name);
        }
        // The pre-persist sentinel is deliberately *not* cleared. It is
        // monotonic: its whole job is to stop the pre-persist keys, which are
        // still sitting on this device, from being republished after the KV
        // entry goes away — and clearing the entry is exactly that case. It is
        // still *recorded* here, so a clear counts as a settling path like any
        // other.
        if (!(await recordPrePersistHandled(state, name))) {
          throw new Error(
            `Could not record the pre-persist sentinel while clearing ${JSON.stringify(name)}`,
          );
        }
        state.finishClear();
      });
    },
  };
}
