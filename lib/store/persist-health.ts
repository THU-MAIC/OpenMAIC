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
  /** Storage is unusable; changes are not being saved. */
  | 'unavailable'
  /** Storage recovered, but edits made while it was down could not be kept. */
  | 'changes-lost'
  /** Storage recovered with nothing lost; retract any standing notice. */
  | 'recovered';

export interface PersistHealthEvent {
  name: string;
  status: PersistHealthStatus;
}

type Listener = (event: PersistHealthEvent) => void;

const listeners = new Set<Listener>();
/** Latest status per key, whether or not it has reached anyone yet. */
const standing = new Map<string, PersistHealthStatus>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Keys whose current problem status actually reached subscribers. */
const delivered = new Set<string>();

/**
 * Publish on a fresh task rather than inline.
 *
 * Recovery usually resolves within a few microtasks of the failure that
 * triggered it, and a warning that appears and vanishes in that window reads as
 * a bug rather than as information. Deferring lets {@link reportPersistHealth}
 * cancel a notice that a successful recovery has already made untrue, and lets
 * a late subscriber be caught up after its toast host has mounted.
 */
function publish(event: PersistHealthEvent): void {
  const timer = setTimeout(() => {
    pending.delete(event.name);
    if (event.status === 'recovered') delivered.delete(event.name);
    else delivered.add(event.name);
    for (const listener of listeners) listener(event);
  }, 0);
  pending.set(event.name, timer);
}

function cancelPending(name: string): void {
  const timer = pending.get(name);
  if (timer !== undefined) {
    clearTimeout(timer);
    pending.delete(name);
  }
}

/** Report a change in a key's persistence health. Repeat statuses are dropped. */
export function reportPersistHealth(name: string, status: PersistHealthStatus): void {
  if (standing.get(name) === status) return;
  standing.set(name, status);
  cancelPending(name);

  // A recovery only has to retract a notice that actually reached someone. If
  // the warning was still waiting its turn, cancelling it *is* the point of
  // publishing on a delay — saying "recovered" for a problem nobody saw would
  // put the flicker back by another route.
  if (status === 'recovered' && !delivered.has(name)) return;
  publish({ name, status });
}

/** Storage is unusable for this key. */
export function reportPersistUnavailable(name: string): void {
  reportPersistHealth(name, 'unavailable');
}

/**
 * Subscribe to persistence health. A listener that arrives after a standing
 * problem is caught up on a later task — React mounts well after the store
 * module runs, so the notice would otherwise be missed exactly when it matters
 * most, and the toast host may itself be a sibling React has not reached yet.
 */
export function subscribeToPersistHealth(listener: Listener): () => void {
  listeners.add(listener);
  const outstanding = [...standing.entries()].filter(([, status]) => status !== 'recovered');
  if (outstanding.length > 0) {
    setTimeout(() => {
      if (!listeners.has(listener)) return;
      for (const [name, status] of outstanding) {
        delivered.add(name);
        listener({ name, status });
      }
    }, 0);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget all reported health. */
export function resetPersistHealth(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  standing.clear();
  delivered.clear();
  listeners.clear();
}
