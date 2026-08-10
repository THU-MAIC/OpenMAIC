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
  type DeviceSafeKVStore,
  type KVScope,
  type KVStore,
  type PersistStorageLike,
} from '@openmaic/storage';
import type { PersistStorage, StorageValue } from 'zustand/middleware';

import { createLogger } from '@/lib/logger';
import { reportPersistHealth } from '@/lib/store/persist-health';

const log = createLogger('KVPersist');

let defaultKv: KVStore | undefined;

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
   * holding the *authoritative* value — one the KV scope actually returned —
   * when the write was taken? A write taken over defaults must not be replayed:
   * writing it back would overwrite the stored value with defaults, the very
   * failure this seam exists to prevent.
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

  /** A read path concluded. */
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
   * than defaults — because the KV scope returned a value.
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

export interface KVPersistDeps {
  /** KV backend. Defaults to the shared browser (`localStorage`) backend. */
  kv?: KVStore;
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

function resolveKv(deps: KVPersistDeps): KVStore | null {
  if (deps.kv) return deps.kv;
  if (!ambientLocalStorage()) return null;
  return (defaultKv ??= new BrowserKVStore());
}

/** True when a KV backend keeps its `device` scope on the machine. */
function isDeviceSafeKVStore(kv: KVStore): kv is DeviceSafeKVStore {
  return (kv as Partial<DeviceSafeKVStore>).servesDeviceScopeLocally === true;
}

/**
 * Best-effort, fire-and-forget removal of a store's pre-cutover raw
 * `localStorage` entry (the value zustand's default storage used to write).
 *
 * This seam **never reads** legacy keys — old data is not migrated; a user
 * upgrading simply reconfigures once — so any leftover raw entry is pure
 * garbage. The old `settings-storage` blob in particular holds plaintext
 * provider API keys, so removing it is a small security win. No correctness
 * depends on this: if it fails, the stale key is ignored forever anyway.
 */
export function purgeLegacyPersistKey(name: string): void {
  const storage = ambientLocalStorage();
  if (!storage) return;
  try {
    storage.removeItem(name);
  } catch (error) {
    log.warn(`Could not purge the legacy "${name}" entry:`, error);
  }
}

/**
 * A zustand `PersistStorage` backed by `KVStore`.
 *
 * This routes a store's persistence through the KV contract and nothing more:
 * it reads and writes the KV scope, and **never touches any legacy
 * `localStorage` key**. There is no migration of pre-cutover data — an empty KV
 * scope hydrates the store to its defaults (ordinary zustand behaviour), and a
 * user upgrading reconfigures once. Automatic migration was removed after
 * repeated review rounds found its legacy-adoption state space too large to
 * keep correct; the reconfiguration cost is one-time and the data is
 * reconstructable.
 *
 * Everything that remains is *async-storage steady state*, not migration
 * scaffolding: the {@link KeyState} machine (hydration gate, write gate,
 * recovery, replay), the {@link Outcome} discipline, per-key serialization, and
 * the {@link reportPersistHealth} channel. A remote KV backend needs all of it;
 * none of it reads a legacy key.
 */
export function createKVPersistStorage<S>(
  scope: KVScope,
  deps: KVPersistDeps = {},
): PersistStorage<S> {
  // Resolved per call rather than once: the store module is evaluated during
  // SSR as well, where there is no storage to bind to yet.
  const resolveKvStorage = (): PersistStorageLike<S> | null => {
    const kv = resolveKv(deps);
    if (!kv) return null;
    // `kvPersistStorage` takes the scope as a literal, not a variable, so that
    // pairing `'device'` with a store whose device scope would leave the machine
    // is a type error. Branch on the scope; the `'device'` overload additionally
    // requires a device-safe store, which is narrowed by its brand (the adapter
    // re-checks it at runtime). The app only wires `'account'` today; the
    // `'device'` arm keeps the generic helper honest.
    if (scope === 'account') return kvPersistStorage<S>(kv, 'account');
    if (isDeviceSafeKVStore(kv)) return kvPersistStorage<S>(kv, 'device');
    throw new Error(
      '@/lib/store/kv-persist: a device-scoped persist store requires a KV backend whose ' +
        'device scope stays local (servesDeviceScopeLocally)',
    );
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
   * land last; the same chain keeps a read, a write, and a clear for one key
   * from interleaving.
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

  /**
   * Settle a read, then replay any write the backend previously refused.
   *
   * Settling opens the write gate. The replay handles the steady-state recovery
   * case: a write refused while the backend was down, taken against the
   * authoritative value, is written back here so the store and storage agree on
   * the user's newest value. It goes through the same gate as any other write,
   * and is held owed until it actually lands (a read succeeding says nothing
   * about whether the write will).
   */
  async function concludeRead(
    state: KeyState<S>,
    name: string,
    value: StorageValue<S> | null,
  ): Promise<StorageValue<S> | null> {
    state.settle();

    const replay = state.peekReplay();
    if (replay === null) return value;
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

  return {
    getItem(name) {
      const state = stateFor(name);
      return serial(name, async () => {
        // A non-null value means the KV scope handed us real data, so the store
        // holds the authoritative value — which is what lets a later refused
        // write be replayed rather than dropped.
        const value = await load();
        if (value !== null) state.noteRealData();
        return value;
      });

      async function load(): Promise<StorageValue<S> | null> {
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
          return null;
        }

        const stored = (await Outcome.run(() => kvStorage.getItem(name))).into(
          state,
          `read "${name}" from the KV ${scope} scope`,
        );
        // A failed read has already been recorded (unavailable, health signal,
        // recovery). Leave the key unsettled — the store keeps whatever it holds
        // and the write gate refuses writes — rather than settling defaults over
        // a value we could not read.
        if (stored === UNAVAILABLE) return null;

        // KV is authoritative. `null` is a legitimate empty store (hydrate
        // defaults); a value hydrates it. Either way the key settles, so writes
        // are admitted — no legacy key is read, no old data is migrated.
        return concludeRead(state, name, stored);
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
        if (!kvStorage) {
          // In a browser this is a real failure the caller must hear about; on
          // the server there is nothing to clear.
          if (isBrowserRuntime()) {
            state.onFailure(
              'reach browser storage',
              new Error('localStorage is unavailable in this browser context'),
            );
            throw new Error(`Could not clear ${JSON.stringify(name)}: storage is unreachable`);
          }
          state.finishClear();
          return;
        }
        // Every failure propagates — a caller clearing a user's data has to be
        // able to tell that it did not happen.
        const removed = (await Outcome.run(() => kvStorage.removeItem(name))).into(
          state,
          `remove "${name}" from the KV ${scope} scope`,
        );
        if (removed === UNAVAILABLE) {
          throw new Error(`Could not remove ${JSON.stringify(name)} from the KV ${scope} scope`);
        }
        state.finishClear();
      });
    },
  };
}
