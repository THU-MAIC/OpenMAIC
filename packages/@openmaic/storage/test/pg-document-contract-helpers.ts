import type { Pool } from 'pg';

import type { Queryable } from '../src/runtime/pg.js';

/**
 * Shared infrastructure for the PostgreSQL document contract suites.
 *
 * The suites live in one file per concern (document store, scene revisions)
 * and share ONE PostgreSQL database, exactly as the PG16 CI job provisions it.
 */

/**
 * Postgres advisory-lock key that makes the document PG suites mutually
 * exclusive. Any fixed value works; this one is just a documented constant,
 * distinct from the agent-session suites' key.
 */
export const DOCUMENT_PG_CONTRACT_LOCK_KEY = 91_110_601;

/**
 * Serialize the document PG suites on the shared database.
 *
 * Both suites provision the SAME document schema in `beforeAll`
 * (`document_stages`, `document_scenes`, the revision companion tables, and
 * the `CREATE OR REPLACE FUNCTION` / `CREATE TRIGGER` statements that
 * reference them). Concurrent provisioning from two vitest processes races on
 * the shared catalog rows ("tuple concurrently updated"), so the suites must
 * never run at the same time. A JS-level lock cannot express this (vitest runs
 * each file in its own process), but a Postgres advisory lock can: it is scoped
 * to a database connection, so it serializes across processes.
 *
 * Call this in `beforeAll`, keep the returned release function for `afterAll`,
 * and give the hook a generous timeout (the waiting suite blocks for the whole
 * duration of the other suite). Every suite that provisions the document
 * schema must take this lock, or a full-suite run becomes scheduling-dependent.
 */
export async function acquireDocumentPgContractLock(pool: Pool): Promise<() => Promise<void>> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [DOCUMENT_PG_CONTRACT_LOCK_KEY]);
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [DOCUMENT_PG_CONTRACT_LOCK_KEY]);
    } finally {
      client.release();
    }
  };
}

/**
 * Empty every document-owned table between PostgreSQL contract tests.
 *
 * TRUNCATE does not fire row triggers, so the revision companion tables must
 * be truncated alongside the rows that would bump them — otherwise a stale
 * revision row makes the next test read a revision the trigger never produced.
 */
export async function truncateDocumentTables(queryable: Queryable): Promise<void> {
  await queryable.query(
    `TRUNCATE document_outlines, document_scenes, document_stages,
            document_scene_revision, document_stage_revision`,
  );
}
