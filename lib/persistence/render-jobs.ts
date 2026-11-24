/**
 * The table behind the durable video export queue (`RENDER_DURABLE_QUEUE`);
 * the queue itself lives in `lib/server/render-queue/`. This module only owns
 * the schema.
 *
 * `render_jobs` holds one row per export. `owner_id` decides who may read,
 * download and cancel it. The uploaded archive and the rendered MP4 are kept
 * in 8 MiB parts under the job's own namespace of the asset byte store
 * (`AssetByteStore.withPrefix`); `input_parts` and `output_parts` list each
 * part's content hash and size, recorded before the part is written, so
 * cleanup can always find every byte a job stored.
 *
 * The lease columns follow generation runs: a worker holds `lease_worker_id`
 * while it dispatches or follows the job, refreshes `lease_heartbeat_at`, and
 * every write it makes names the `lease_generation` it claimed. `render_target`
 * and `render_job_id` say where the job was sent and under which id, so a
 * worker that takes the lease over asks the render service about the same job.
 * `attempt` counts dispatches; a job lost by the render service is sent again
 * until it reaches the limit.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

export const RENDER_JOB_MIGRATIONS: SchemaMigrationSet = {
  store: 'render-jobs',
  migrations: [
    {
      version: 1,
      name: 'baseline',
      transaction: false,
      up: `
CREATE TABLE IF NOT EXISTS render_jobs (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  status              TEXT NOT NULL,
  input_content_type  TEXT NOT NULL,
  input_parts         JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_parts        JSONB NOT NULL DEFAULT '[]'::jsonb,
  output_bytes        BIGINT NOT NULL DEFAULT 0,
  render_target       TEXT,
  render_job_id       TEXT,
  attempt             INTEGER NOT NULL DEFAULT 0,
  lease_worker_id     TEXT,
  lease_heartbeat_at  BIGINT,
  lease_generation    INTEGER NOT NULL DEFAULT 0,
  progress            DOUBLE PRECISION NOT NULL DEFAULT 0,
  stage               TEXT,
  error_code          TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  CONSTRAINT render_jobs_status_known CHECK (status IN
    ('uploading','queued','dispatched','running','succeeded','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS render_jobs_status_created_idx
  ON render_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS render_jobs_owner_active_idx
  ON render_jobs (owner_id) WHERE status IN ('uploading','queued','dispatched','running');
`,
    },
  ],
};

/** Create the table, or bring it up to date. Safe on every start. */
export async function ensureRenderJobSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, RENDER_JOB_MIGRATIONS);
}
