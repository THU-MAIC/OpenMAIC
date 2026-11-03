/**
 * Refuse, as the server starts, a database this release must not run against.
 *
 * Every store is provisioned lazily -- the persistence provider on the first
 * request or background pass, the agent runtime's stores on first use -- and a
 * failure there is answered and retried. That is right for an unreachable
 * database, which may come up a moment later, but not for a refusal no retry
 * can change: a database that records a schema version newer than this
 * release knows (it was upgraded by a newer release), or, outside production,
 * an applied migration whose checksum changed. Such a server would stay up
 * answering every request that touches the store with a 500.
 *
 * So the start reads the recorded versions of every store this application
 * knows ({@link APP_SCHEMA_STORES}) -- read-only, creating nothing, so a store
 * of a disabled feature is checked without being provisioned -- and a refusal
 * exits the process like any other boot failure. Started without being
 * awaited: `register()` must not block on I/O.
 */
import { verifySchemaMigrations } from '@openmaic/storage/pg-migrations';
import { Pool } from 'pg';

import { APP_SCHEMA_STORES } from '@/lib/persistence/schema-stores';

/** Recognized by name, so a refusal thrown by another copy of the storage package counts. */
const SCHEMA_REFUSALS = new Set(['SchemaVersionAheadError', 'SchemaMigrationChecksumError']);

export function isSchemaRefusal(error: unknown): boolean {
  return error instanceof Error && SCHEMA_REFUSALS.has(error.name);
}

export type SchemaCheckPoolFactory = (connectionString: string) => Pool;

/** A running release can become incompatible after another instance migrates the database. */
export async function assertRuntimeSchemaCompatibility(): Promise<void> {
  const { getServerPersistenceProvider } = await import('./server-provider');
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  await verifySchemaMigrations(pool, APP_SCHEMA_STORES);
}

/** Keep every Node server protected, including deployments without Agent workers. */
export function startRuntimeSchemaMonitor(onSchemaRefusal: (error: unknown) => Promise<void>) {
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      await assertRuntimeSchemaCompatibility();
    } catch (error) {
      if (stopped) return;
      if (!isSchemaRefusal(error)) {
        console.error('[persistence] Runtime schema check failed; retrying next interval', error);
        return;
      }
      stopped = true;
      clearInterval(timer);
      // The retirement callback drains the monitor too; never await that drain here.
      void Promise.resolve()
        .then(() => onSchemaRefusal(error))
        .catch((failure) => console.error('[persistence] Schema retirement failed', failure));
    } finally {
      checking = false;
    }
  };
  // The one-time boot check covers startup; ongoing process checks run every 30s.
  const timer = setInterval(() => void check(), 30_000);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function startSchemaBootCheck(
  connectionString: string,
  poolFactory: SchemaCheckPoolFactory = (value) => new Pool({ connectionString: value, max: 1 }),
): Promise<void> {
  const pool = poolFactory(connectionString.trim());
  // An idle connection that drops is reported here, not thrown at the process.
  pool.on('error', (error) => {
    console.error('[persistence] Schema check connection failed', error);
  });
  try {
    await verifySchemaMigrations(pool, APP_SCHEMA_STORES);
  } catch (error) {
    if (!isSchemaRefusal(error)) {
      console.error(
        '[persistence] Could not check the schema versions at startup; each store checks ' +
          'them again when it is first used',
        error,
      );
      return;
    }
    const { exitOnBootFailure } = await import('@/lib/server/boot-failure');
    await exitOnBootFailure(error);
  } finally {
    await pool.end().catch(() => {});
  }
}
