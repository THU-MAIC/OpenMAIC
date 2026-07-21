/**
 * Device-anonymous learner identity for the runtime layer (#869).
 *
 * `learnerKey` partitions all learner-runtime data (RuntimeStore sessions).
 * Until sign-in exists it is a per-device anonymous key: minted once and kept
 * in the KV `device` scope, which never syncs across devices — a synced key
 * would merge two people's runtime into one partition. When sign-in lands,
 * `RuntimeStore.mergeLearner(anonKey, accountKey)` is the migration path.
 *
 * Client-only: the default KV store lazily touches `localStorage`. Server
 * code must not import this without injecting its own `KVStore`.
 */
import { BrowserKVStore, type KVStore } from '@openmaic/storage';

import { registerRuntimeStorageResetHook, resolveConfiguredLearnerKey } from './config';

export const LEARNER_KEY_KV_KEY = 'runtime.learnerKey';

const LEARNER_KEY_LOCK = 'maic:learner-key';

let defaultKv: KVStore | undefined;
let defaultInFlight: Promise<string> | undefined;
let configuredInFlight: Promise<string> | undefined;

registerRuntimeStorageResetHook(() => {
  configuredInFlight = undefined;
  defaultInFlight = undefined;
  defaultKv = undefined;
});

function mintLearnerKey(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `anon:${uuid}`;
}

async function mintPersisted(store: KVStore): Promise<string> {
  const minted = mintLearnerKey();
  await store.set(LEARNER_KEY_KV_KEY, minted, 'device');
  // Return the PERSISTED value, not the local mint: if another writer raced
  // us, everyone converges on the stored winner instead of keeping an
  // orphaned key of their own.
  return (await store.get<string>(LEARNER_KEY_KV_KEY, 'device')) ?? minted;
}

async function readOrMint(store: KVStore): Promise<string> {
  const existing = await store.get<string>(LEARNER_KEY_KV_KEY, 'device');
  if (existing) return existing;

  if (typeof navigator !== 'undefined' && navigator.locks) {
    // Cross-tab mutual exclusion: only one tab mints under the lock; a tab
    // that lost the race re-reads the winner's key inside its own grant. An
    // existing key is never overwritten, so the per-tab memo stays safe.
    return await navigator.locks.request(LEARNER_KEY_LOCK, async () => {
      const won = await store.get<string>(LEARNER_KEY_KV_KEY, 'device');
      return won ?? mintPersisted(store);
    });
  }
  // No Web Locks (older browsers, non-window contexts): read-after-write
  // only. Residual race: a tab whose re-read lands before another tab's
  // write keeps an orphaned key. Accepted here — it merely splits one
  // anonymous learner's local history, and these contexts are rare.
  return mintPersisted(store);
}

/**
 * Resolve the client session's learner partition key.
 *
 * An explicit KV store takes priority over app-wide configuration. Without an
 * explicit store, a configured provider is invoked only on first resolution:
 * concurrent calls share its in-flight promise and the first resolved value is
 * retained for the session. Identity changes mid-session belong in the
 * application layer (reload or a `mergeLearner` flow).
 *
 * Client-only: this singleton is not SSR-safe or intended for request-scoped
 * identity. Partial dev-mode HMR can recreate this cache independently of the
 * configuration module; reload after changing bootstrap configuration.
 */
export function getLearnerKey(kv?: KVStore): Promise<string> {
  // Injected stores (tests, server-side callers) bypass the memo but stay
  // race-safe through the lock / read-after-write above.
  if (kv) return readOrMint(kv);

  const configured = configuredInFlight ?? resolveConfiguredLearnerKey();
  if (configured) {
    configuredInFlight ??= configured.catch((error) => {
      configuredInFlight = undefined;
      throw error;
    });
    return configuredInFlight;
  }
  // Concurrent same-bundle callers share one in-flight read/mint. A failure
  // is not cached — a transient storage error must not pin every later call.
  defaultInFlight ??= readOrMint((defaultKv ??= new BrowserKVStore())).catch((error) => {
    defaultInFlight = undefined;
    throw error;
  });
  return defaultInFlight;
}
