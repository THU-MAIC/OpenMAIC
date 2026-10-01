/**
 * The tables behind server-side generation runs (RFC #1754 §E); the run
 * engine and its store live in `lib/server/generation/run/`. This module only
 * owns the schema.
 *
 * - `generation_runs`: one row per run. `owner_id` decides who may read and
 *   command it. The lease columns follow the agent runtime's sessions: a
 *   worker holds `lease_worker_id` while it executes, refreshes
 *   `lease_heartbeat_at`, and every write it makes names the
 *   `lease_generation` it claimed, so a worker whose lease was taken over can
 *   no longer write. `takeovers` counts consecutive orphaned claims of the
 *   same step (reset by every committed step).
 * - `generation_run_steps`: the checkpoint of every completed step, keyed by
 *   step id. A takeover resumes after the last one.
 * - `generation_run_events`: the run's ordered event log (`seq` per run, the
 *   run row's `seq` is the last one allocated).
 * - `generation_run_commands`: commands by their caller's `command_id`, so a
 *   repeated command answers what the first one did.
 *
 * Version 2 adds `media_pending`: a run that is paused or completed still has
 * media to generate (a retried image, a video whose wait was interrupted).
 * Such a run holds no step, so the claim reads this flag instead of the run's
 * state; every commit that gives the lease up recomputes it from the media
 * checkpoints. It also indexes the runs still producing a course by
 * `stage_id`, which every content write of a course looks up.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS generation_runs (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  input               JSONB NOT NULL,
  state               TEXT NOT NULL,
  step                TEXT,
  outline             JSONB,
  outline_revision    INTEGER NOT NULL DEFAULT 0,
  agents              JSONB,
  stage_id            TEXT,
  scenes_total        INTEGER NOT NULL DEFAULT 0,
  scenes_completed    INTEGER NOT NULL DEFAULT 0,
  error               JSONB,
  seq                 BIGINT NOT NULL DEFAULT 0,
  lease_worker_id     TEXT,
  lease_heartbeat_at  BIGINT,
  lease_generation    INTEGER NOT NULL DEFAULT 0,
  takeovers           INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT generation_runs_state_known CHECK (state IN
    ('preparing','outlining','awaiting_outline_confirmation','generating','paused','completed','ended'))
);

CREATE INDEX IF NOT EXISTS generation_runs_owner_active_idx
  ON generation_runs (owner_id, created_at) WHERE state NOT IN ('completed','ended');

CREATE INDEX IF NOT EXISTS generation_runs_executable_idx
  ON generation_runs (updated_at) WHERE state IN ('preparing','outlining','generating');

CREATE TABLE IF NOT EXISTS generation_run_steps (
  run_id       TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  step_id      TEXT NOT NULL,
  output       JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS generation_run_events (
  run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  seq    BIGINT NOT NULL,
  ts     BIGINT NOT NULL,
  type   TEXT NOT NULL,
  data   JSONB NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS generation_run_commands (
  run_id     TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  result     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, command_id)
)`;

const MEDIA_PENDING = `
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS media_pending BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS generation_runs_media_pending_idx
  ON generation_runs (updated_at) WHERE media_pending AND state IN ('paused','completed');

CREATE INDEX IF NOT EXISTS generation_runs_stage_active_idx
  ON generation_runs (stage_id) WHERE state NOT IN ('completed','ended')`;

export const GENERATION_RUN_MIGRATIONS: SchemaMigrationSet = {
  store: 'generation-runs',
  migrations: [
    { version: 1, name: 'baseline', up: SCHEMA, transaction: false },
    { version: 2, name: 'media_pending', up: MEDIA_PENDING },
  ],
};

export async function ensureGenerationRunSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, GENERATION_RUN_MIGRATIONS);
}
