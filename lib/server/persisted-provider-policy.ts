/**
 * Database-backed provider policy resolver.
 *
 * The database is authoritative whenever server persistence is configured.
 * Environment values are used only to bootstrap the first row, which lets an
 * existing deployment migrate without a behavior change. A database failure
 * is surfaced instead of silently unlocking a deployment.
 */

import { createLogger } from '@/lib/logger';
import type { Queryable } from '@openmaic/storage/runtime/pg';
import {
  readProviderPolicy,
  upsertProviderPolicy,
  type ProviderPolicyInput,
  type ProviderPolicyRow,
} from '@/lib/persistence/provider-policy';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

const log = createLogger('PersistedProviderPolicy');

let cachedConnectionString: string | undefined;
let cachedAt = 0;
let cachedPolicy: ProviderPolicyRow | null | undefined;
let inFlight: Promise<ProviderPolicyRow | null> | undefined;
const CACHE_TTL_MS = 2_000;

function readEnvBootstrap(): ProviderPolicyInput | null {
  const llmProviderId = process.env.OPENMAIC_LLM_ONLY_PROVIDER?.trim();
  const llmModelId = process.env.OPENMAIC_LLM_ONLY_MODEL?.trim();
  const audioOnly = process.env.OPENMAIC_AUDIO_ONLY_PROVIDER?.trim().toLowerCase();
  const llmLocked = Boolean(llmProviderId && llmModelId);
  const audioLocked = audioOnly === 'doubao';
  if (!llmLocked && !audioLocked) return null;
  return {
    llmLocked,
    llmProviderId: llmLocked ? llmProviderId : null,
    llmModelId: llmLocked ? llmModelId : null,
    audioLocked,
    ttsProviderId: audioLocked ? 'doubao-tts' : null,
    asrProviderId: audioLocked ? 'doubao-asr' : null,
  };
}

async function loadPersistedPolicy(connectionString: string): Promise<ProviderPolicyRow | null> {
  const provider = await getServerPersistenceProvider(connectionString);
  const queryable = provider.pool as unknown as Queryable;
  let row = await readProviderPolicy(queryable);
  if (!row) {
    // One-time migration path: the old env policy seeds the database, after
    // which the row remains authoritative even if those env vars are removed.
    const bootstrap = readEnvBootstrap();
    if (bootstrap) {
      await upsertProviderPolicy(queryable, bootstrap);
      row = await readProviderPolicy(queryable);
    }
  }
  return row;
}

/** Clear the short-lived cache after an operator updates the policy row. */
export function clearPersistedProviderPolicyCache(): void {
  cachedConnectionString = undefined;
  cachedAt = 0;
  cachedPolicy = undefined;
  inFlight = undefined;
}

export async function getPersistedProviderPolicy(): Promise<ProviderPolicyRow | null> {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  const now = Date.now();
  if (
    cachedConnectionString === connectionString &&
    cachedPolicy !== undefined &&
    now - cachedAt < CACHE_TTL_MS
  ) {
    return cachedPolicy;
  }
  if (inFlight) return inFlight;
  inFlight = loadPersistedPolicy(connectionString)
    .then((policy) => {
      cachedConnectionString = connectionString;
      cachedAt = Date.now();
      cachedPolicy = policy;
      return policy;
    })
    .catch((error) => {
      log.error('Failed to read database provider policy', error);
      throw error;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}
