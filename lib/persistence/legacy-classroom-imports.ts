/**
 * The ledger of the one-time import of file-stored classrooms
 * (`lib/server/legacy-classroom-import.ts`).
 *
 * One row per legacy classroom id the import has an outcome for:
 *
 * - `imported`: written in the course's own create transaction, so the two
 *   cannot disagree. Final.
 * - `skipped`: the classroom cannot be imported as it stands (invalid, a
 *   reservation placeholder, its id taken, the create refused by the host, or
 *   it failed {@link MAX_IMPORT_ATTEMPTS} times). Final, with the reason.
 * - `failed`: an attempt failed; `attempts` counts them and `detail` holds the
 *   last error. Retried until it becomes one of the two above.
 *
 * A classroom the run never reached (the run stopped first) has no row.
 *
 * Temporary, like the importer: remove with it.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS legacy_classroom_imports (
  legacy_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  stage_id TEXT,
  owner_id TEXT,
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export const LEGACY_CLASSROOM_IMPORT_MIGRATIONS: SchemaMigrationSet = {
  store: 'legacy-classroom-imports',
  migrations: [{ version: 1, name: 'baseline', up: SCHEMA }],
};

export async function ensureLegacyClassroomImportSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, LEGACY_CLASSROOM_IMPORT_MIGRATIONS);
}

/** Failed attempts after which a classroom is settled as skipped. */
export const MAX_IMPORT_ATTEMPTS = 3;

export type LegacyClassroomImportOutcome = 'imported' | 'skipped' | 'failed';

export interface LegacyClassroomImportRecord {
  legacyId: string;
  outcome: 'imported' | 'skipped';
  stageId?: string;
  ownerId?: string;
  detail?: string;
}

/** Every legacy id the ledger holds a final outcome for (`imported` or `skipped`). */
export async function readSettledLegacyClassroomIds(queryable: Queryable): Promise<Set<string>> {
  const result = await queryable.query<{ legacy_id: string } & Record<string, unknown>>(
    "SELECT legacy_id FROM legacy_classroom_imports WHERE outcome IN ('imported', 'skipped')",
  );
  return new Set(result.rows.map((row) => row.legacy_id));
}

/** Record a final outcome. It replaces a `failed` row, and never another final one. */
export async function recordLegacyClassroomImport(
  queryable: Queryable,
  record: LegacyClassroomImportRecord,
): Promise<void> {
  await queryable.query(
    `INSERT INTO legacy_classroom_imports (legacy_id, outcome, stage_id, owner_id, detail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (legacy_id) DO UPDATE
       SET outcome = EXCLUDED.outcome, stage_id = EXCLUDED.stage_id,
           owner_id = EXCLUDED.owner_id, detail = EXCLUDED.detail, recorded_at = now()
       WHERE legacy_classroom_imports.outcome = 'failed'`,
    [
      record.legacyId,
      record.outcome,
      record.stageId ?? null,
      record.ownerId ?? null,
      record.detail ?? null,
    ],
  );
}

/**
 * Count one failed attempt, keeping `message` as the last error. The attempt
 * that reaches {@link MAX_IMPORT_ATTEMPTS} settles the classroom as skipped
 * in the same statement, so no crash can leave a row at the limit still
 * `failed`. Answers the count and whether the classroom is now settled.
 */
export async function recordLegacyClassroomFailure(
  queryable: Queryable,
  legacyId: string,
  message: string,
): Promise<{ attempts: number; settled: boolean }> {
  const result = await queryable.query<
    { attempts: number; outcome: string } & Record<string, unknown>
  >(
    `INSERT INTO legacy_classroom_imports AS ledger (legacy_id, outcome, detail, attempts)
     VALUES ($1,
             CASE WHEN 1 >= $3 THEN 'skipped' ELSE 'failed' END,
             CASE WHEN 1 >= $3 THEN 'repeated failure: ' || $2 ELSE $2 END,
             1)
     ON CONFLICT (legacy_id) DO UPDATE
       SET attempts = ledger.attempts + 1,
           outcome = CASE WHEN ledger.attempts + 1 >= $3 THEN 'skipped' ELSE 'failed' END,
           detail = CASE WHEN ledger.attempts + 1 >= $3
                         THEN 'repeated failure: ' || $2 ELSE $2 END,
           recorded_at = now()
       WHERE ledger.outcome = 'failed'
     RETURNING attempts, outcome`,
    [legacyId, message, MAX_IMPORT_ATTEMPTS],
  );
  const row = result.rows[0];
  // No row: the classroom was already settled, which a failure cannot change.
  if (!row) return { attempts: MAX_IMPORT_ATTEMPTS, settled: true };
  return { attempts: row.attempts, settled: row.outcome === 'skipped' };
}
