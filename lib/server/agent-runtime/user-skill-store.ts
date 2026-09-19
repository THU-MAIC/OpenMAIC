/**
 * Lazy process-wide binding of the durable user-skill store.
 *
 * Lives in its own module so the runner's tool modules (`user-skills.ts`,
 * `skill-edit-tools.ts`, `create-skill.ts`) can import `getUserSkillStore` as a
 * cross-module binding — which is what lets tests point the whole tool surface
 * at a PGlite-backed store with a single module mock, exactly like the
 * reference product's `getDb()` seam.
 */
import { PgUserSkillStore, ensureUserSkillSchema } from '@openmaic/storage/skill/pg';

import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

import type { Queryable, WithTransaction } from '@openmaic/storage/skill/pg';
import type { Pool } from 'pg';

export type { Queryable, WithTransaction } from '@openmaic/storage/skill/pg';

interface UserSkillStoreState {
  connectionString?: string;
  storePromise?: Promise<PgUserSkillStore>;
}

const USER_SKILL_STORE_STATE_KEY = Symbol.for('openmaic.agent-user-skill.store');
const globalState = globalThis as typeof globalThis & {
  [USER_SKILL_STORE_STATE_KEY]?: UserSkillStoreState;
};
const storeState = (globalState[USER_SKILL_STORE_STATE_KEY] ??= {});

/**
 * Adapt a node-postgres pool to the storage package's transaction contract.
 * Every transaction uses one checked-out client for its entire lifetime.
 */
export function nodePostgresTransaction(pool: Pool): WithTransaction {
  return async <T>(body: (queryable: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function createUserSkillStore(connectionString: string): Promise<PgUserSkillStore> {
  const { pool } = await getServerPersistenceProvider(connectionString);
  await ensureUserSkillSchema(pool);
  return new PgUserSkillStore(pool, { withTransaction: nodePostgresTransaction(pool) });
}

/**
 * Return the process-wide user-skill store, initializing its schema lazily.
 * Failed initialization is cleared so a later request can retry after the
 * database becomes available.
 */
export function getUserSkillStore(): Promise<PgUserSkillStore> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Promise.reject(new Error('Agent runtime requires DATABASE_URL'));
  }
  if (storeState.storePromise && storeState.connectionString === connectionString) {
    return storeState.storePromise;
  }

  storeState.connectionString = connectionString;
  const initialization = createUserSkillStore(connectionString).catch((error) => {
    if (storeState.storePromise === initialization) {
      storeState.storePromise = undefined;
      storeState.connectionString = undefined;
    }
    throw error;
  });
  storeState.storePromise = initialization;
  return initialization;
}
