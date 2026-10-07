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
 * `stage_id` (and the completed ones with media pending), which every content
 * write of a course and its deletion look up; both queries' predicates imply
 * the index's.
 *
 * Version 3 adds what a finished run reports after its checkpoints are
 * compacted away: `narration_unvoiced`, the speech clips its narration left
 * silent (the asset store refused them, or the voice is not the tts slot's),
 * and `media_summary`, the counts of its images and videos (`total`,
 * `failed`), written by the compaction from the media checkpoints it removes.
 *
 * Version 5 adds `host_attributes`: the string attributes a host's
 * `authorizeStart` hook attached to the run when it admitted it
 * (`lib/server/generation-run-hooks`), handed back to the host's hooks on
 * every execution of the run. Null for a run started without them.
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
  ON generation_runs (stage_id) WHERE state NOT IN ('completed','ended') OR media_pending`;

const RUN_REPORT = `
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS narration_unvoiced INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS media_summary JSONB`;

// When a waiting `countdown` run confirms its own outline; any process's
// runner confirms the runs that are due.
const OUTLINE_AUTO_CONFIRM = `
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS outline_auto_confirm_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS generation_runs_outline_auto_confirm_idx
  ON generation_runs (outline_auto_confirm_at)
  WHERE state = 'awaiting_outline_confirmation' AND outline_auto_confirm_at IS NOT NULL`;

// What a host attached to the run when it admitted it; never shown to the owner.
const HOST_ATTRIBUTES = `
ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS host_attributes JSONB`;

export const GENERATION_RUN_MIGRATIONS: SchemaMigrationSet = {
  store: 'generation-runs',
  migrations: [
    { version: 1, name: 'baseline', up: SCHEMA, transaction: false },
    { version: 2, name: 'media_pending', up: MEDIA_PENDING },
    { version: 3, name: 'run_report', up: RUN_REPORT },
    { version: 4, name: 'outline_auto_confirm', up: OUTLINE_AUTO_CONFIRM },
    { version: 5, name: 'host_attributes', up: HOST_ATTRIBUTES },
  ],
};

export async function ensureGenerationRunSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, GENERATION_RUN_MIGRATIONS);
}
