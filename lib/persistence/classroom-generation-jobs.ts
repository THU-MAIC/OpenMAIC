/**
 * The table behind `POST /api/generate-classroom` jobs.
 *
 * One row per job: the owner the job runs for, and the job record the poll
 * route answers with, as JSONB. The record's shape belongs to
 * `lib/server/classroom-job-store.ts`; this module only owns the table.
 * `owner_id` is a column rather than a record field because it decides who may
 * read the row, and that must never depend on a merge of the record.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

// Jobs are only ever read by id, so the primary key is the only index.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS classroom_generation_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  record JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export async function ensureClassroomGenerationJobSchema(queryable: Queryable): Promise<void> {
  await queryable.query(SCHEMA);
}
