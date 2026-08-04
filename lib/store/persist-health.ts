/**
 * A one-way channel from the persistence seam to the UI.
 *
 * When `lib/store/kv-persist.ts` refuses to write — because the key never
 * hydrated and persisting from an un-hydrated store would overwrite real data
 * with defaults — the user's changes stop being saved. That is invisible by
 * construction: the app keeps working, the store keeps updating in memory, and
 * everything is lost on reload. It has to be said out loud.
 *
 * Kept deliberately small and framework-free so the store seam, which is also
 * evaluated during SSR, does not pull the toast stack into its module graph.
 */
export type PersistHealthStatus =
  /** Storage is unusable; changes are not being saved. Resolvable. */
  | 'unavailable'
  /** Storage recovered, but edits made while it was down are gone. Final. */
  | 'changes-lost'
  /** Storage recovered with nothing lost; retract any standing notice. */
  | 'recovered';

export interface PersistHealthEvent {
  name: string;
  status: PersistHealthStatus;
}

type Listener = (event: PersistHealthEvent) => void;

const listeners = new Set<Listener>();
/**
 * Two independent lines per key, because the statuses answer different
 * questions and resolve on different timescales.
 *
 * `unavailable` describes the state of the world right now and stops being true
 * the moment storage works again. `changes-lost` describes something that
 * already happened: recovering afterwards does not un-lose the edits, so it
 * survives any number of later failures and recoveries and goes away only when
 * the user dismisses it.
 */
const unavailable = new Set<string>();
const lost = new Set<string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Keys whose `unavailable` notice actually reached subscribers. */
const delivered = new Set<string>();
/** Catch-up timers for subscribers that arrived after a problem was raised. */
const catchUps = new Map<Listener, ReturnType<typeof setTimeout>>();

/**
 * Publish on a fresh task rather than inline.
 *
 * Recovery usually resolves within a few microtasks of the failure that
 * triggered it, and a warning that appears and vanishes in that window reads as
 * a bug rather than as information. Deferring lets {@link reportPersistHealth}
 * cancel a notice a successful recovery has already made untrue, and lets a
 * late subscriber be caught up after its toast host has mounted.
 */
function publish(event: PersistHealthEvent): void {
  const slot = `${event.name}:${event.status === 'changes-lost' ? 'lost' : 'fault'}`;
  const timer = setTimeout(() => {
    pending.delete(slot);
    if (event.status === 'recovered') delivered.delete(event.name);
    else if (event.status === 'unavailable') delivered.add(event.name);
    for (const listener of listeners) listener(event);
  }, 0);
  pending.set(slot, timer);
}

function cancelPending(slot: string): void {
  const timer = pending.get(slot);
  if (timer !== undefined) {
    clearTimeout(timer);
    pending.delete(slot);
  }
}

/**
 * Report a change in a key's persistence health. Repeat statuses are dropped.
 *
 * `changes-lost` is a fait accompli, not a condition: the edits are already
 * gone, so a later recovery has nothing to retract and leaves it standing.
 * `unavailable` is the opposite — it describes a state of the world, and stops
 * being true the moment storage works again.
 */
export function reportPersistHealth(name: string, status: PersistHealthStatus): void {
  if (status === 'changes-lost') {
    if (lost.has(name)) return;
    lost.add(name);
    publish({ name, status });
    return;
  }

  if (status === 'recovered') {
    // Only the transient line recovers. A standing `changes-lost` is untouched:
    // storage working again does not bring the edits back.
    if (!unavailable.delete(name)) return;
    cancelPending(`${name}:fault`);
    // Only retract a notice that actually reached someone. If the warning was
    // still waiting its turn, cancelling it *is* the point of publishing on a
    // delay — announcing recovery from a problem nobody saw would put the
    // flicker back by another route.
    if (!delivered.has(name)) return;
    publish({ name, status });
    return;
  }

  if (unavailable.has(name)) return;
  unavailable.add(name);
  cancelPending(`${name}:fault`);
  publish({ name, status });
}

/**
 * The user has acknowledged a lost-changes notice.
 *
 * Clearing the latch is what makes the notice re-armable: without it the same
 * store losing changes a second time is swallowed as a duplicate, and any
 * subscriber that mounts later resurrects a toast the user already dismissed.
 */
export function acknowledgePersistLoss(name: string): void {
  lost.delete(name);
  cancelPending(`${name}:lost`);
}

/** Storage is unusable for this key. */
export function reportPersistUnavailable(name: string): void {
  reportPersistHealth(name, 'unavailable');
}

/**
 * Subscribe to persistence health. A listener that arrives while a problem is
 * standing is caught up on a later task — React mounts well after the store
 * module runs, so the notice would otherwise be missed exactly when it matters
 * most, and the toast host may itself be a sibling React has not reached yet.
 *
 * The catch-up re-reads the current state when it fires rather than replaying
 * the snapshot taken at subscribe time: a recovery in between must not be
 * overtaken by a stale warning that then has nothing left to dismiss it.
 */
export function subscribeToPersistHealth(listener: Listener): () => void {
  listeners.add(listener);
  if (lost.size > 0 || unavailable.size > 0) {
    catchUps.set(
      listener,
      setTimeout(() => {
        catchUps.delete(listener);
        if (!listeners.has(listener)) return;
        for (const name of lost) listener({ name, status: 'changes-lost' });
        for (const name of unavailable) {
          delivered.add(name);
          listener({ name, status: 'unavailable' });
        }
      }, 0),
    );
  }
  return () => {
    listeners.delete(listener);
    const catchUp = catchUps.get(listener);
    if (catchUp !== undefined) {
      clearTimeout(catchUp);
      catchUps.delete(listener);
    }
  };
}

/** Test-only: forget all reported health. */
export function resetPersistHealth(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  for (const timer of catchUps.values()) clearTimeout(timer);
  pending.clear();
  catchUps.clear();
  unavailable.clear();
  lost.clear();
  delivered.clear();
  listeners.clear();
}
