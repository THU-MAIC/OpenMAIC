import type { Pool } from 'pg';

import type { Queryable } from '../src/runtime/pg.js';

/**
 * Shared infrastructure for the PostgreSQL agent-session contract suites.
 *
 * The suites live in one file per backend (store, material) and share ONE
 * PostgreSQL database, exactly as the PG16 CI job provisions it. That shared
 * database is why everything here exists; see the two sections below.
 */

/**
 * Postgres advisory-lock key that makes the agent-session PG suites mutually
 * exclusive. Any value works; this one is just a fixed, documented constant.
 */
export const AGENT_SESSION_PG_CONTRACT_LOCK_KEY = 91_110_533;

/**
 * Serialize the agent-session PG suites on the shared database.
 *
 * Both suites TRUNCATE the same tables between tests (`agent_sessions` and the
 * tables that reference it), because both create sessions with identical fixed
 * ids. That is only safe when the suites never run at the same time: if two
 * suites were running concurrently, either suite's `beforeEach` would wipe the
 * rows the other suite's test just created and the tests would fail with
 * missing sessions. A JS-level lock cannot express this (vitest runs each file
 * in its own process), but a Postgres advisory lock can: it is scoped to a
 * database connection, so it serializes across processes.
 *
 * Call this in `beforeAll`, keep the returned release function for `afterAll`,
 * and give the hook a generous timeout (the waiting suite blocks for the whole
 * duration of the other suite). Every suite that TRUNCATEs agent-session tables
 * must take this lock, or a full-suite run becomes scheduling-dependent.
 */
export async function acquireAgentSessionPgContractLock(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [AGENT_SESSION_PG_CONTRACT_LOCK_KEY]);
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [AGENT_SESSION_PG_CONTRACT_LOCK_KEY]);
    } finally {
      client.release();
    }
  };
}

/**
 * Empty every agent-session-owned table between PostgreSQL contract tests.
 *
 * The statement lists only the tables the agent-session backend owns and lets
 * `CASCADE` reach everything else that references `agent_sessions`. That
 * indirection is the point: an exhaustive list would have to grow every time a
 * store adds a foreign key to `agent_sessions` — the material store did exactly
 * that, and once its suite had ensured its schema, the agent-session suite's
 * plain TRUNCATE was rejected with `cannot truncate a table referenced in a
 * foreign key constraint`, failing the whole PG job whenever the material suite
 * ran first. `CASCADE` follows the foreign-key graph instead, so a future
 * FK-referencing store is cleaned up automatically, in any file order, with no
 * edit here (see the `beforeEach cleanup` probe test in the agent-session
 * suite).
 */
export async function truncateAgentSessionTables(queryable: Queryable): Promise<void> {
  await queryable.query(
    `TRUNCATE agent_session_entries, agent_session_events,
            agent_owner_session_events, agent_owner_session_event_counters,
            agent_session_urls, agent_sessions CASCADE`,
  );
}
