import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

/**
 * PostgreSQL advisory-lock key serializing schema bootstrap across processes.
 * Any fixed value works; it only has to be the same in every instance of this
 * application and distinct from the keys the storage package's test suites
 * take.
 */
export const SCHEMA_BOOTSTRAP_LOCK_KEY = 71_310_523;

/**
 * Run a schema bootstrap with every other instance's bootstrap held off.
 *
 * `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` and
 * `CREATE OR REPLACE FUNCTION` are not atomic across sessions: two instances
 * starting together against the same database can both decide an object is
 * missing and one fails on the catalog's unique index (or with "tuple
 * concurrently updated"), which answers its first request with a 500. The
 * statements are idempotent one at a time, so running the bootstraps one
 * after another is all it takes.
 *
 * The lock is session-level and taken on one dedicated connection, which runs
 * every statement of `body` and is released in `finally`: the lock cannot be
 * held by a connection that went back to the pool, and a connection that dies
 * mid-bootstrap releases it with the session. It lives here, at the
 * application's bootstrap, rather than in each package `ensure*Schema`
 * function, because what must be serialized is the whole sequence -- package
 * tables and this application's own (`stage_meta`, owner materials) alike --
 * and every caller that provisions schema goes through this one helper.
 */
export async function withSchemaBootstrapLock<T>(
  pool: ConnectableQueryable,
  body: (queryable: Queryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [SCHEMA_BOOTSTRAP_LOCK_KEY]);
    try {
      return await body(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [SCHEMA_BOOTSTRAP_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
