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
 * `maic:device:<prefix><name>` in the browser backend.
 */
const PRE_PERSIST_PREFIX = '__pre-persist-consulted:';

/**
 * Records that this device has migrated a store's pre-cutover raw entry into
 * KV. Its job is to **suppress re-adoption**, and it is genuinely load-bearing:
 * the adopt branch reads it on every load.
 *
 * Adoption keeps the raw entry (see the header — deleting it cannot be done
 * safely on `localStorage`). So once KV holds the value, the raw copy is a
 * *frozen* pre-cutover shadow: writes only ever reach KV, never the raw key. If
 * the account KV is later emptied by something that is **not** a local clear —
 * a server-side wipe, an account switch, KV eviction — then a naive "KV empty +
 * raw present ⇒ adopt" would resurrect that stale shadow, refilling the wiped
 * account with ancient values and syncing them to every device. The marker
 * turns "KV empty + already migrated here" into "respect the wipe", not "adopt
 * again".
 *
 * It is **monotonic**: only ever set to `true`. Concurrent writers all write the
 * same value and it is never deleted except by a deliberate full clear, so —
 * unlike deleting the raw entry — there is no compare-and-delete race. That
 * monotonicity is exactly why it is safe where the raw delete was not. This is
 * live state with a real reader, not the delete-authorization marker removed in
 * the previous revision.
 */
const MIGRATED_PREFIX = '__migrated:';

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

/**
 * What a read hands to the store, and whether the KV scope vouched for it.
 *
 * `provisional` marks a value nothing authoritative confirmed — the raw entry
 * served after a failed read, or one handed back by a migration that could not
 * be completed. It hydrates the store, because it is the best copy available,
 * but it earns no replay authority: an edit taken on top of it must never be
 * written back over whatever the account scope actually holds.
 */
interface LoadedValue<S> {
  value: StorageValue<S> | null;
  provisional?: boolean;
}

type KeyPhase = 'unhydrated' | 'settled' | 'unavailable' | 'clearing';

interface KeyStateHooks {
  /**
   * Ask the store to rehydrate after `delayMs`; the backend may have
   * recovered. `done` is called once the attempt has finished, however it
   * finished, so the machine can tell a settle caused by a recovery from one
   * caused by ordinary use.
   */
  requestRecovery: (name: string, delayMs: number, done: () => void) => void;
  /** Delay before each attempt. Its length is the cap on attempts. */
  backoffMs: readonly number[];
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
  #recoveryAttempts = 0;
  #recoveryInFlight = false;
  #recoveryExhausted = false;

  constructor(
    private readonly name: string,
    private readonly hooks: KeyStateHooks,
  ) {}

  get phase(): KeyPhase {
    return this.#phase;
  }

  /**
   * Whether the KV scope has already handed this session the authoritative
   * value. Once it has, a later failed read must not walk the store backwards
   * onto a shadowed raw copy.
   */
  get hasAuthoritativeValue(): boolean {
    return this.#storeHoldsRealData;
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
    if (this.#settleOutcome()) this.#rearmRecoveryIfHealthy();
  }

  /** Returns false when the key was left untouched (a clear is in progress). */
  #settleOutcome(): boolean {
    if (this.#phase === 'clearing') {
      // A read that finishes mid-clear says nothing about the clear. Opening
      // the gate here would admit a write that then queues behind the pending
      // delete and puts the just-deleted value straight back — and under a
      // remote backend a recovery rehydrate being in flight during a clear is
      // ordinary, not a corner case. Only `finishClear` opens this key.
      this.#refused = null;
      this.#replay = null;
      return false;
    }

    this.#phase = 'settled';

    const refused = this.#refused;
    this.#refused = null;
    if (refused === null) {
      // Storage works again and nothing was owed, so retract any standing
      // notice. Deferred publishing means a recovery this quick usually
      // cancels the warning before anyone sees it.
      reportPersistHealth(this.name, 'recovered');
      return true;
    }

    if (refused.replayable) {
      // Handed back through `takeReplay`, so the recovering read returns it and
      // storage and the store agree on the user's newest value rather than
      // diverging.
      this.#replay = refused.value;
      log.info(`Replaying the write that was refused for "${this.name}"`);
      reportPersistHealth(this.name, 'recovered');
      return true;
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
      return true;
    }
    log.error(
      `Changes to "${this.name}" made while its storage was unavailable could not be saved, and ` +
        `have been replaced by the stored value`,
    );
    // The debt is settled, unhappily; the re-arm in `settle` then gives a
    // future failure a fresh budget rather than an exhausted one.
    reportPersistHealth(this.name, 'changes-lost');
    return true;
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
    // Belt and braces against a future path that remembers a write mid-clear:
    // nothing from before a deletion may survive it.
    this.#refused = null;
    this.#replay = null;
    this.#rearmRecoveryIfHealthy();
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

  /**
   * The value a recovering read should write back and return in place of what
   * it found. Left in place until {@link replayLanded} says it is durable —
   * a read that succeeds says nothing about whether the write will, and a
   * snapshot dropped on the strength of an attempt is a snapshot lost.
   */
  peekReplay(): StorageValue<S> | null {
    return this.#replay;
  }

  /** The replay write landed; nothing is owed any more. */
  replayLanded(): void {
    this.#replay = null;
    this.#refused = null;
    this.#storeHoldsRealData = true;
    this.#rearmRecoveryIfHealthy();
  }

  /**
   * The replay write did not land. The snapshot goes back to being a refused
   * write — still the newest copy of the user's data, still owed — so the next
   * recovery tries again and a permanent failure is eventually reported rather
   * than passing as success.
   */
  replayFailed(): void {
    const value = this.#replay;
    this.#replay = null;
    if (value === null) return;
    this.#refused = { value, replayable: this.#storeHoldsRealData, origin: this.#phase };
  }

  /**
   * Schedule one rehydrate, backing off and eventually giving up.
   *
   * A backend that reads but cannot write — a quota-exhausted one does exactly
   * that — turns recovery into a treadmill: the read succeeds, the key settles,
   * the replay write fails, and that failure asks for recovery again. Without a
   * cap that is an unbounded loop of microtasks, and the app is worse off than
   * if nothing had been retried at all.
   */
  #askForRecovery(): void {
    if (this.#recoveryInFlight || this.#recoveryExhausted) return;
    const { backoffMs } = this.hooks;
    if (this.#recoveryAttempts >= backoffMs.length) {
      this.#recoveryExhausted = true;
      log.error(
        `Giving up on recovering "${this.name}" after ${backoffMs.length} attempts; storage stays ` +
          `read-only until something outside this session changes`,
      );
      // Whatever was owed is not going to be written. Say so rather than
      // leaving a queue of retries the user cannot see failing.
      if (this.#refused !== null || this.#replay !== null) {
        reportPersistHealth(this.name, 'changes-lost');
      }
      return;
    }
    const delayMs = backoffMs[this.#recoveryAttempts++] ?? 0;
    this.#recoveryInFlight = true;
    this.hooks.requestRecovery(this.name, delayMs, () => this.#onRecoveryFinished());
  }

  /**
   * One attempt has run its course. If the key is still unhealthy, spend the
   * next slot in the budget — an attempt that fails part-way through leaves
   * nothing else to trigger the retry, and the debt would otherwise sit there
   * unpaid and unannounced.
   */
  #onRecoveryFinished(): void {
    this.#recoveryInFlight = false;
    const owed = this.#refused !== null || this.#replay !== null;
    if (this.#phase === 'unavailable' || owed) this.#askForRecovery();
  }

  /**
   * Re-arm the recovery budget, but only on real progress: nothing left owed.
   * A settle reached *by* a recovery attempt, with a replay still queued to
   * write, is not progress — counting it as such is exactly what makes the
   * treadmill above unbounded, because every lap looks like a fresh start.
   */
  #rearmRecoveryIfHealthy(): void {
    if (this.#refused !== null || this.#replay !== null) return;
    this.#recoveryAttempts = 0;
    this.#recoveryExhausted = false;
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
  /**
   * Delay before each recovery attempt, in order. The array's *length* is the
   * cap: after this many attempts the key is left read-only until something
   * outside the session changes it, rather than retrying forever.
   *
   * A backend that reads but cannot write would otherwise loop: the read
   * succeeds, the key settles, the replay write fails, and the failure asks for
   * recovery again. Injectable so tests can drive the cap without waiting.
   */
  recoveryBackoffMs?: readonly number[];
}

/** Three tries, spread out enough that a transient fault has time to clear. */
export const DEFAULT_RECOVERY_BACKOFF_MS: readonly number[] = [0, 250, 1000];

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
 * where it is: we never adopt bytes we could not interpret.
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
    // is how a raw entry gets adopted-over while still holding data.
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

/**
 * Drop the raw entry, or say so.
 *
 * Used only by the clear path, where the user asked for this data to be gone
 * and a swallowed failure is how "deleted" data comes back: the raw entry
 * survives, and the next hydration finds an empty KV scope beside a live raw
 * entry and dutifully re-adopts it. Migration never deletes the raw entry at
 * all (see the header note on the shadow duplicate), so this is the one place
 * a raw entry is removed.
 */
function dropLegacyEntryStrictly(storage: Storage | null, name: string): void {
  storage?.removeItem(name);
}

/**
 * A zustand `PersistStorage` backed by `KVStore`, which adopts the store's
 * pre-cutover raw `localStorage` entry on first read.
 *
 * Adoption is a copy: the value is written to KV and the raw entry is left in
 * place. Deleting it cannot be done safely during this transition — `localStorage`
 * has no cross-process atomic compare-and-delete (its storage mutex was dropped
 * from the spec), so a tab on an old bundle can overwrite the raw key between a
 * verify and a remove and have its newer value destroyed. So the seam does not
 * delete: once KV holds the entry it is authoritative, reads take the KV value
 * and never consume the raw one, and the raw shadow is inert — a duplicate
 * kept for a wholesale raw-cleanup at migration exit, never a source of truth.
 * Adoption is idempotent for the same reason: a second run finds the KV value
 * present and takes the read-from-KV path rather than adopting again.
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
        backoffMs: deps.recoveryBackoffMs ?? DEFAULT_RECOVERY_BACKOFF_MS,
        // Deferred: recovery usually calls back into `persist.rehydrate()`,
        // and running that inside a `setItem` call would re-enter the store
        // mid-update. A recovery that throws is just a recovery that did not
        // work — the key stays unavailable and its notice stands, so there is
        // nothing to do but say what happened.
        requestRecovery: (key, delayMs, done) => {
          setTimeout(() => {
            void Promise.resolve()
              .then(() => deps.onWriteRefused?.(key))
              .catch((error) => log.error(`Recovery attempt for "${key}" failed:`, error))
              .finally(done);
          }, delayMs);
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

  /**
   * Record — best effort — that this device has migrated `name`. Not routed
   * through the state machine on purpose: a failed marker write is an
   * acceptable degradation, not an `unavailable` condition. The KV value's
   * presence already de-duplicates every ordinary load; the marker matters only
   * once the account KV has been emptied externally, so resurrection needs both
   * this write to have failed *and* a later external wipe — rare enough that
   * escalating a false alarm here would be the worse trade.
   */
  async function recordMigrated(name: string): Promise<void> {
    const kv = resolveKv(deps);
    if (!kv) return;
    try {
      await kv.set(MIGRATED_PREFIX + name, true, SENTINEL_SCOPE);
    } catch (error) {
      log.warn(`Could not record the migrated marker for "${name}":`, error);
    }
  }

  /**
   * Clear the migrated marker — best effort — on a deliberate full clear, so the
   * key returns to a genuine first-load state. With the raw entry already gone
   * by the time this runs, a leftover marker is inert (there is nothing left to
   * resurrect), so a failure here does not fail the clear.
   */
  async function clearMigratedMarker(name: string): Promise<void> {
    const kv = resolveKv(deps);
    if (!kv) return;
    try {
      await kv.remove(MIGRATED_PREFIX + name, SENTINEL_SCOPE);
    } catch (error) {
      log.warn(`Could not clear the migrated marker for "${name}":`, error);
    }
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

    const replay = state.peekReplay();
    if (replay === null) return value;
    // A write refused while the backend was down, taken against the
    // authoritative value. Persisted here rather than left to the store to
    // write back: it goes through the same gate as any other write, and
    // returning it too means the store and storage agree on the user's newest
    // value instead of the read handing back a value it has just superseded.
    if (!state.admitWrite(replay)) return value;
    const kvStorage = resolveKvStorage();
    if (!kvStorage) {
      state.replayFailed();
      return replay;
    }
    const written = (await Outcome.run(() => kvStorage.setItem(name, replay))).into(
      state,
      `replay the refused write for "${name}" to the KV ${scope} scope`,
    );
    if (written === UNAVAILABLE) {
      // Readable but not writable — a quota-exhausted backend answers reads
      // fine. The edit is still owed, so it stays owed.
      state.replayFailed();
      return replay;
    }
    state.replayLanded();
    return replay;
  }

  /**
   * Move a value into the KV scope — a copy, not a move.
   *
   * The raw `localStorage` entry is deliberately **left in place**. Deleting it
   * safely is impossible here: `localStorage` has no cross-process atomic
   * compare-and-delete (the storage mutex was dropped from the spec), so a tab
   * running an *old bundle* — which takes none of this seam's locks — can
   * overwrite the raw key with newer settings in the window between "verify"
   * and "remove", and the remove then destroys that newer value. Rather than
   * race, the seam does not delete at all during this transition. The KV entry
   * is authoritative — once it exists, reads take the KV value and never
   * consume the raw one — so the shadow duplicate is inert, left for a wholesale
   * raw-cleanup at migration exit. See the file header.
   *
   * `source` only labels the log line (`localStorage` vs the pre-persist keys);
   * both callers behave identically now that nothing is deleted or marked.
   */
  async function adopt(
    state: KeyState<S>,
    kvStorage: PersistStorageLike<S>,
    name: string,
    value: StorageValue<S>,
    source: string,
  ): Promise<LoadedValue<S>> {
    // One last look before committing. Another tab may have written something
    // newer while this migration was being assembled; `KVStore` has no
    // compare-and-set, so this narrows the window rather than closing it. With
    // no delete, losing the race costs only a redundant write of equivalent
    // data — the raw entry it would once have deleted is now always kept.
    const current = (await Outcome.run(() => kvStorage.getItem(name))).into(
      state,
      `re-read "${name}" from the KV ${scope} scope`,
    );
    // An abandoned migration hands back the raw entry unadopted. That is the
    // same provisional footing as a failed read: nothing has vouched for it, so
    // it hydrates the store but earns no replay authority.
    if (current === UNAVAILABLE) return { value, provisional: true };
    if (current !== null) {
      // Another tab populated KV first; serve the winner and keep the shadow.
      return { value: await concludeRead(state, name, current) };
    }

    const written = (await Outcome.run(() => kvStorage.setItem(name, value))).into(
      state,
      `write "${name}" to the KV ${scope} scope`,
    );
    if (written === UNAVAILABLE) return { value, provisional: true };

    // Remember that this device migrated this key, so a future load after the
    // account KV is emptied externally does not resurrect the frozen raw shadow.
    await recordMigrated(name);
    log.info(`Migrated "${name}" from ${source} into the KV ${scope} scope`);
    return { value: await concludeRead(state, name, value) };
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

      async function load(): Promise<LoadedValue<S>> {
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
          if (state.hasAuthoritativeValue) {
            // This session has already loaded the authoritative value, and the
            // store is still holding it. Serving the shadowed raw copy now
            // would walk a live store *backwards* onto an older value — and
            // because zustand leaves state alone when a read yields nothing,
            // returning null is precisely "keep what you have".
            log.warn(
              `Could not re-read "${name}" from the KV ${scope} scope; keeping the value already ` +
                `loaded rather than falling back to the shadowed localStorage copy`,
            );
            return { value: null };
          }
          // Nothing authoritative has been seen yet, so the raw entry is the
          // best copy available. Serve it so the store hydrates with the user's
          // data, but adopt nothing, delete nothing, and leave the key
          // unsettled so no write can persist over an original we were unable
          // to read.
          const fallback = readLegacy<S>(state, legacyStorage, name);
          return { value: fallback === UNAVAILABLE ? null : fallback, provisional: true };
        }

        if (stored !== null) {
          // KV is authoritative and wins the read. A raw entry may still shadow
          // it (a completed migration's leftover, or an old bundle's newer
          // write); either way it is left untouched — see `adopt`.
          return { value: await concludeRead(state, name, stored) };
        }

        const adopted = readLegacy<S>(state, legacyStorage, name);
        if (adopted === UNAVAILABLE) return { value: null };
        if (adopted !== null) {
          const migrated = (await readSentinel(MIGRATED_PREFIX, name)).into(
            state,
            `read the migrated marker for "${name}"`,
          );
          // A failed marker read must not be read as "not migrated" — that
          // could resurrect a stale shadow. Fail closed: unsettled, retry next
          // load.
          if (migrated === UNAVAILABLE) return { value: null };
          if (!migrated) {
            // First migration on this device: copy the raw entry into KV and
            // record it. The raw entry itself is left in place — see `adopt`.
            return adopt(state, kvStorage, name, adopted, 'localStorage');
          }
          // Already migrated here, yet KV read came back empty. A local clear
          // removes the raw entry too, so an empty KV beside a live raw entry
          // means KV was emptied by something external — a server-side wipe, an
          // account switch, eviction — and the raw entry is a frozen pre-cutover
          // shadow, not new data. Do NOT adopt it. But the empty read may just
          // be stale (another tab repopulated KV since), so fall through to the
          // confirm re-read below rather than concluding the wipe outright.
        }

        // Reached with either no raw entry, or a raw entry this device has
        // already migrated (declined above). Empty KV here is also exactly what
        // another tab's in-flight adoption looks like — it may have written the
        // KV entry between our two reads. Under a remote backend that is
        // ordinary, so confirm before concluding there is nothing to load.
        const confirmed = (await Outcome.run(() => kvStorage.getItem(name))).into(
          state,
          `re-read "${name}" from the KV ${scope} scope`,
        );
        if (confirmed === UNAVAILABLE) return { value: null };
        if (confirmed !== null) {
          // A concurrent write landed in the interval; KV wins, shadow kept.
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
              return adopt(state, kvStorage, name, prePersist, 'the pre-persist keys');
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
        // Raw entry first, and every failure propagates — a caller clearing a
        // user's data has to be able to tell that it did not happen.
        //
        // Order matters more than it looks. Removing the KV entry first and
        // then failing on the raw one leaves an empty scope beside a live raw
        // entry, which is exactly the shape the next hydration re-adopts: the
        // "deleted" settings come straight back. Failing on the raw entry
        // before anything else is removed leaves the KV value authoritative and
        // the clear simply unperformed, which the caller can retry.
        try {
          dropLegacyEntryStrictly(resolveLegacyStorage(deps), name);
        } catch (error) {
          state.onFailure(`drop the legacy "${name}" entry`, error);
          throw error;
        }
        if (kvStorage) {
          const removed = (await Outcome.run(() => kvStorage.removeItem(name))).into(
            state,
            `remove "${name}" from the KV ${scope} scope`,
          );
          if (removed === UNAVAILABLE) {
            throw new Error(`Could not remove ${JSON.stringify(name)} from the KV ${scope} scope`);
          }
        } else if (isBrowserRuntime()) {
          state.onFailure(
            'reach browser storage',
            new Error('localStorage is unavailable in this browser context'),
          );
          throw new Error(`Could not clear ${JSON.stringify(name)}: storage is unreachable`);
        }
        // A deliberate full clear returns this key to a genuine first-load
        // state, so the migrated marker goes too. Best effort: the raw entry is
        // already gone, so a leftover marker is inert.
        await clearMigratedMarker(name);
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
