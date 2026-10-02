/**
 * A startup check of the instance secret against the keys already stored
 * (`lib/server/secret-box.ts`). Keys a workspace saves in the model settings
 * are sealed under `OPENMAIC_SECRET_KEY`, or under a secret generated in
 * `data/instance-secret.key` when it is unset. On a host whose data directory
 * does not survive a restart, or with several replicas, each start or replica
 * generates its own secret and the stored keys stop opening; on a read-only
 * one, no secret can be created and saving a key fails. This warns about both
 * at boot. It never refuses to start, and costs one query.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { inspectInstanceSecret, type InstanceSecretState } from '@/lib/server/secret-box';

const log = createLogger('SecretBox');

/** Stored sealed secrets by the key id that sealed them. */
export type StoredSecretKids = Record<string, number>;

const ADVICE =
  'Set OPENMAIC_SECRET_KEY (any long random string, the same on every instance) so stored keys survive restarts and replicas.';

/** The warnings for a secret state and the stored keys; empty when all is well. */
export function instanceSecretWarnings(
  state: InstanceSecretState,
  stored: StoredSecretKids,
): string[] {
  const warnings: string[] = [];
  const secretCreatable = state.configured || state.fileExists || state.dataDirWritable;
  if (!secretCreatable) {
    warnings.push(
      `OPENMAIC_SECRET_KEY is not set and ${state.file} cannot be created (the data directory is not writable): saving a provider key in the model settings will fail. ${ADVICE}`,
    );
  }
  const sealed = Object.values(stored).reduce((sum, count) => sum + count, 0);
  if (!sealed) return warnings;
  if (!state.configured && !state.fileExists) {
    warnings.push(
      `OPENMAIC_SECRET_KEY is not set and ${state.file} does not exist, but the database holds ${sealed} provider key(s) sealed under an earlier instance secret. ${
        secretCreatable ? 'A new secret will be generated, and those' : 'Those'
      } keys cannot be read: they have to be entered again in the model settings, unless the previous ${state.file} is restored or OPENMAIC_SECRET_KEY is set to the secret that sealed them. ${ADVICE}`,
    );
    return warnings;
  }
  if (!state.kid) return warnings;
  const unreadable = Object.entries(stored)
    .filter(([kid]) => kid !== state.kid)
    .reduce((sum, [, count]) => sum + count, 0);
  if (unreadable) {
    const source = state.configured ? 'OPENMAIC_SECRET_KEY' : state.file;
    warnings.push(
      `${unreadable} provider key(s) stored in the database were sealed under a different instance secret than the current one (${source}) and cannot be read: they have to be entered again in the model settings, unless the previous secret is restored.${
        state.configured ? '' : ` ${ADVICE}`
      }`,
    );
  }
  return warnings;
}

/** How many stored secrets each key id sealed (one query); empty before the table exists. */
export async function storedSecretKids(queryable: Queryable): Promise<StoredSecretKids> {
  try {
    const { rows } = await queryable.query<
      { kid: string; count: number } & Record<string, unknown>
    >(
      `SELECT s.value->>'kid' AS kid, count(*)::int AS count
         FROM workspace_model_config w
         CROSS JOIN LATERAL jsonb_each(w.secrets) s
        WHERE jsonb_typeof(s.value) = 'object' AND s.value ? 'kid'
        GROUP BY 1`,
    );
    return Object.fromEntries(rows.map((row) => [row.kid, Number(row.count)]));
  } catch (error) {
    // No settings were ever saved on this database.
    if ((error as { code?: string }).code === '42P01') return {};
    throw error;
  }
}

/** Log the instance secret warnings for this server. Never throws. */
export async function warnAboutInstanceSecret(
  databaseUrl = process.env.DATABASE_URL?.trim(),
): Promise<void> {
  // Without a database the model settings store no keys.
  if (!databaseUrl) return;
  try {
    const state = inspectInstanceSecret();
    const { getServerPersistenceProvider } = await import('@/lib/persistence/server-provider');
    const { pool } = await getServerPersistenceProvider(databaseUrl);
    for (const warning of instanceSecretWarnings(state, await storedSecretKids(pool))) {
      log.warn(warning);
    }
  } catch (error) {
    log.warn(
      `Could not check the instance secret against the stored keys: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
