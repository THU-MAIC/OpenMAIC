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
type Listener = (name: string) => void;

const listeners = new Set<Listener>();
let reported: string | null = null;

/** Report that writes for `name` are being refused. Idempotent per key. */
export function reportPersistUnavailable(name: string): void {
  if (reported === name) return;
  reported = name;
  for (const listener of listeners) listener(name);
}

/**
 * Subscribe to persistence failures. A listener that arrives after the failure
 * is told immediately — React mounts well after the store module runs, so the
 * notice would otherwise be missed exactly when it matters most.
 */
export function subscribeToPersistUnavailable(listener: Listener): () => void {
  listeners.add(listener);
  if (reported !== null) listener(reported);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget any reported failure. */
export function resetPersistHealth(): void {
  reported = null;
  listeners.clear();
}
