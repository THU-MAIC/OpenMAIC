/**
 * PostgreSQL store of generation runs: creation under the per-owner limit,
 * lease claims with generations (fencing), checkpointed step commits, the
 * ordered event log, and idempotent owner commands.
 *
 * The coordination follows the agent runtime's sessions
 * (`@openmaic/storage/agent-session/pg`): PostgreSQL is the authority for who
 * executes a run; a worker's every write names the lease generation it
 * claimed and is refused once another worker took the run over; a `NOTIFY`
 * queued in the same transaction as a durable event wakes the readers at
 * commit, and every reader keeps a fallback poll because NOTIFY is lossy.
 *
 * Ownership: a run belongs to the owner that started it, and to the account
 * that owner was claimed into since (the same rule as classroom jobs, without
 * moving the rows). Every other owner gets the same answer as for an unknown
 * run.
 */
import { randomBytes } from 'node:crypto';

import { DocumentWriteRefusedError } from '@openmaic/storage';
import type { Queryable } from '@openmaic/storage/document/pg';
import { encodeJson } from '@openmaic/storage/pg-json';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { ensureGenerationRunSchema } from '@/lib/persistence/generation-runs';
import { startOwnerMaterialExtractions } from '@/lib/persistence/owner-materials';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';
import { notifyDurableAgentEvent } from '@/lib/server/agent-runtime/event-notify-bus';
import type { SceneOutline } from '@/lib/types/generation';

import { generationRunConfig } from './config';
import {
  FINAL_RUN_MEDIA_FAILURE_CODES,
  isRetryableRunMedia,
  MEDIA_STEP_PREFIX,
  mediaStepId,
  stateForRetry,
} from './plan';
import {
  ACTIVE_RUN_STATES,
  EXECUTABLE_RUN_STATES,
  LIMITED_RUN_STATES,
  OUTLINE_AUTO_CONFIRM_MS,
  type GenerationRunAgentsResult,
  type GenerationRunEvent,
  type GenerationRunFailure,
  type GenerationRunInput,
  type GenerationRunMediaCheckpoint,
  type GenerationRunOutline,
  type GenerationRunSnapshot,
  type ExecutableRunState,
  type GenerationRunState,
  type NewGenerationRunEvent,
} from './types';

/** A worker's claim on a run: every write it makes names it. */
export interface RunLease {
  runId: string;
  workerId: string;
  generation: number;
}

/** The worker no longer holds the run: another worker took it over, or the run left its phase. */
export class GenerationRunLeaseLostError extends Error {
  constructor(readonly lease: RunLease) {
    super(`generation run ${lease.runId}: lease generation ${lease.generation} is no longer held`);
    this.name = 'GenerationRunLeaseLostError';
  }
}

export function isGenerationRunLeaseLostError(error: unknown): boolean {
  return error instanceof Error && error.name === 'GenerationRunLeaseLostError';
}

/** The owner already has as many active runs as the limit allows. */
export class ActiveRunLimitError extends Error {
  constructor(readonly limit: number) {
    super(
      `At most ${limit} course generation${limit === 1 ? '' : 's'} may be in progress at once ` +
        '(paused ones and ones waiting for their outline to be confirmed do not count); wait for ' +
        'one to finish or pause, or delete its course, and try again.',
    );
    this.name = 'ActiveRunLimitError';
  }
}

/** A command the run cannot take in its current state. The message is caller-facing. */
export class RunCommandConflictError extends Error {
  constructor(
    readonly reason:
      | 'state'
      | 'outline-revision'
      | 'command-reused'
      | 'course-exists'
      /** The media element is not one of the run's, or not a failure Retry can change. */
      | 'media',
    message: string,
  ) {
    super(message);
    this.name = 'RunCommandConflictError';
  }
}

/** A compacted run's image and video counts (its media checkpoints are gone). */
export interface RunMediaSummary {
  total: number;
  failed: number;
}

export interface StoredRun extends GenerationRunSnapshot {
  ownerId: string;
  /** Speech clips the narration left silent (refused by the asset store, or a voice off the slot). */
  narrationUnvoiced: number;
  /** Set once the run is compacted: what its media checkpoints counted. */
  mediaSummary: RunMediaSummary | null;
  /** A paused or completed run still has media to generate (see the schema). */
  mediaPending: boolean;
  leaseWorkerId: string | null;
  leaseHeartbeatAt: number | null;
  leaseGeneration: number;
  takeovers: number;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  input: GenerationRunInput;
  state: GenerationRunState;
  step: string | null;
  outline: GenerationRunOutline | null;
  outline_revision: number;
  agents: GenerationRunAgentsResult | null;
  stage_id: string | null;
  scenes_total: number;
  scenes_completed: number;
  error: GenerationRunFailure | null;
  seq: string | number;
  lease_worker_id: string | null;
  lease_heartbeat_at: string | number | null;
  lease_generation: number;
  takeovers: number;
  media_pending: boolean;
  narration_unvoiced: number;
  media_summary: RunMediaSummary | null;
  outline_auto_confirm_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const RUN_COLUMNS = `id, owner_id, input, state, step, outline, outline_revision, agents, stage_id,
  scenes_total, scenes_completed, error, seq, lease_worker_id, lease_heartbeat_at,
  lease_generation, takeovers, media_pending, narration_unvoiced, media_summary,
  outline_auto_confirm_at, created_at, updated_at`;

function isoTimestamp(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function storedRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    ownerId: row.owner_id,
    mediaPending: row.media_pending,
    narrationUnvoiced: row.narration_unvoiced,
    mediaSummary: row.media_summary,
    state: row.state,
    step: row.step,
    seq: Number(row.seq),
    input: row.input,
    outline: row.outline ? { ...row.outline, revision: row.outline_revision } : null,
    agents: row.agents,
    stageId: row.stage_id,
    progress: { scenesTotal: row.scenes_total, scenesCompleted: row.scenes_completed },
    error: row.error,
    ...(row.outline_auto_confirm_at
      ? { outlineAutoConfirmAt: isoTimestamp(row.outline_auto_confirm_at) }
      : {}),
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at),
    leaseWorkerId: row.lease_worker_id,
    leaseHeartbeatAt: row.lease_heartbeat_at === null ? null : Number(row.lease_heartbeat_at),
    leaseGeneration: row.lease_generation,
    takeovers: row.takeovers,
  };
}

/** The part of a stored run its owner reads. */
export function runSnapshot(run: StoredRun): GenerationRunSnapshot {
  return {
    id: run.id,
    state: run.state,
    step: run.step,
    seq: run.seq,
    input: run.input,
    outline: run.outline,
    agents: run.agents,
    stageId: run.stageId,
    progress: run.progress,
    error: run.error,
    ...(run.outlineAutoConfirmAt ? { outlineAutoConfirmAt: run.outlineAutoConfirmAt } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** A fresh run id. */
export function generateRunId(): string {
  return `run-${randomBytes(12).toString('base64url')}`;
}

export function isRunId(value: string): boolean {
  return /^run-[A-Za-z0-9_-]{16}$/.test(value);
}

/** What one fenced commit changes on the run row besides its sequence number. */
export interface RunPatch {
  state?: GenerationRunState;
  step?: string | null;
  outline?: GenerationRunOutline;
  outlineRevision?: number;
  agents?: GenerationRunAgentsResult;
  stageId?: string;
  scenesTotal?: number;
  scenesCompleted?: number;
  error?: GenerationRunFailure | null;
  /** Speech clips this commit's scene left silent: added to the run's count. */
  narrationUnvoiced?: number;
  /** Release the lease with this commit (the run waits, pauses or ends). */
  releaseLease?: boolean;
  /**
   * The outline waits for confirmation: a run that is a `countdown` one at
   * this commit gets its auto-confirm deadline. Any other state change
   * clears the deadline.
   */
  outlineAutoConfirm?: boolean;
}

export interface StepCommit {
  /** The checkpoint this commit records, if it completes a step. */
  step?: { id: string; output: unknown };
  /** More checkpoints recorded with it (media the same write placed). */
  steps?: Array<{ id: string; output: unknown }>;
  patch?: RunPatch;
  events?: NewGenerationRunEvent[];
}

/**
 * The owner predicate: the run's owner, or any owner claimed into the reader,
 * however many claims ago (the merge records are followed transitively).
 */
const OWNED_BY = (ownerParam: string) =>
  `owner_id IN (
     WITH RECURSIVE merged(id) AS (
       SELECT ${ownerParam}::text
       UNION
       SELECT m.from_owner_id FROM owner_merges m JOIN merged ON m.to_owner_id = merged.id
     )
     SELECT id FROM merged)`;

/** How many claims a chain of merge records may span before it is taken as corrupt. */
const MAX_MERGE_HOPS = 16;

const SCHEMA_STATE_KEY = Symbol.for('openmaic.generation-runs.schema');
const schemaState = globalThis as typeof globalThis & {
  [SCHEMA_STATE_KEY]?: { connectionString: string; ready: Promise<void> };
};

async function provider() {
  const connectionString = process.env.DATABASE_URL ?? '';
  const persistence = await getServerPersistenceProvider(connectionString);
  // Provisioned lazily, like the agent runtime's tables: the first use of
  // runs in a process creates or migrates them under the bootstrap lock.
  const cached = schemaState[SCHEMA_STATE_KEY];
  if (!cached || cached.connectionString !== connectionString) {
    const ready = withSchemaBootstrapLock(
      persistence.pool as unknown as ConnectableQueryable,
      ensureGenerationRunSchema,
    );
    schemaState[SCHEMA_STATE_KEY] = { connectionString, ready };
    ready.catch(() => {
      if (schemaState[SCHEMA_STATE_KEY]?.ready === ready) delete schemaState[SCHEMA_STATE_KEY];
    });
  }
  await schemaState[SCHEMA_STATE_KEY]!.ready;
  return persistence;
}

/** Forget the provisioned schema (tests that drop it). */
export function resetGenerationRunSchemaForTests(): void {
  delete schemaState[SCHEMA_STATE_KEY];
}

async function notifyOwner(tx: Queryable, ownerId: string): Promise<void> {
  // The owner, and every account it was claimed into since, read its runs.
  let current: string | undefined = ownerId;
  for (let hop = 0; current && hop <= MAX_MERGE_HOPS; hop += 1) {
    await notifyDurableAgentEvent(tx, { kind: 'generation-run-owner', ownerId: current });
    const merged: { rows: Array<{ to_owner_id: string }> } = await tx.query<{
      to_owner_id: string;
    }>('SELECT to_owner_id FROM owner_merges WHERE from_owner_id = $1', [current]);
    current = merged.rows[0]?.to_owner_id;
  }
}

/**
 * The owner a stored owner id belongs to now, following every claim since
 * (background work reads what the account holds after a claim moved it).
 */
export async function currentOwnerOf(storedOwnerId: string): Promise<string> {
  const { pool } = await provider();
  let current = storedOwnerId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    const merged = await pool.query<{ to_owner_id: string }>(
      'SELECT to_owner_id FROM owner_merges WHERE from_owner_id = $1',
      [current],
    );
    const next = merged.rows[0]?.to_owner_id;
    if (!next) return current;
    current = next;
  }
  throw new Error(
    `The claims of owner ${storedOwnerId} form a chain longer than ${MAX_MERGE_HOPS}`,
  );
}

/**
 * Compact the runs that finished (completed or ended) more than `graceMs`
 * ago to what their final snapshot needs: their checkpoints go, and so does
 * every event but the final commit's two (`completed`/`ended` and `state`).
 * A follower still sees how a run ended; one further behind is told to
 * reload the snapshot (the events stream's `resync`). A completed run with an
 * image or video a Retry may still generate keeps everything, so that Retry
 * still works. The counts of a compacted run's images and videos stay on the
 * run (`media_summary`). Answers how many runs it compacted.
 */
export async function compactFinishedGenerationRuns(graceMs: number): Promise<number> {
  const { withTransaction } = await provider();
  return withTransaction(async (tx) => {
    const finished = await tx.query<{ id: string }>(
      `SELECT id FROM generation_runs r
        WHERE state IN ('completed', 'ended') AND updated_at < now() - make_interval(secs => $1)
          AND NOT media_pending
          AND NOT (state = 'completed' AND EXISTS (
            SELECT 1 FROM generation_run_steps s
             WHERE s.run_id = r.id AND s.step_id LIKE '${MEDIA_STEP_PREFIX}%'
               AND (s.output->>'status' = 'skipped'
                    OR (s.output->>'status' = 'failed'
                        AND COALESCE(s.output->>'errorCode', '') <> ALL($2::text[])))))
          AND (EXISTS (SELECT 1 FROM generation_run_steps s WHERE s.run_id = r.id)
               OR EXISTS (SELECT 1 FROM generation_run_events e
                           WHERE e.run_id = r.id AND e.seq <= r.seq - 2))
        ORDER BY id LIMIT 500`,
      [graceMs / 1000, [...FINAL_RUN_MEDIA_FAILURE_CODES]],
    );
    const ids = finished.rows.map((row) => row.id);
    if (ids.length === 0) return 0;
    // What the media checkpoints counted outlives them, for the final report.
    await tx.query(
      `UPDATE generation_runs r SET media_summary = s.summary
         FROM (SELECT run_id,
                      jsonb_build_object(
                        'total', count(*),
                        'failed', count(*) FILTER (WHERE output->>'status' = 'failed')) AS summary
                 FROM generation_run_steps
                WHERE run_id = ANY($1) AND step_id LIKE '${MEDIA_STEP_PREFIX}%'
                GROUP BY run_id) s
        WHERE r.id = s.run_id`,
      [ids],
    );
    await tx.query('DELETE FROM generation_run_steps WHERE run_id = ANY($1)', [ids]);
    await tx.query(
      `DELETE FROM generation_run_events e USING generation_runs r
        WHERE e.run_id = r.id AND r.id = ANY($1) AND e.seq <= r.seq - 2`,
      [ids],
    );
    return ids.length;
  });
}

/** Append events under the run row lock (held by the caller), allocating their seqs. */
async function insertEvents(
  tx: Queryable,
  runId: string,
  events: readonly NewGenerationRunEvent[],
): Promise<number> {
  if (events.length === 0) {
    const current = await tx.query<{ seq: string | number }>(
      'SELECT seq FROM generation_runs WHERE id = $1',
      [runId],
    );
    return Number(current.rows[0]?.seq ?? 0);
  }
  const allocated = await tx.query<{ seq: string | number }>(
    'UPDATE generation_runs SET seq = seq + $2 WHERE id = $1 RETURNING seq',
    [runId, events.length],
  );
  const last = Number(allocated.rows[0]!.seq);
  const first = last - events.length + 1;
  const ts = Date.now();
  for (const [index, event] of events.entries()) {
    await tx.query(
      `INSERT INTO generation_run_events (run_id, seq, ts, type, data)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [runId, first + index, ts, event.type, encodeJson(event.data, 'generation run event')],
    );
  }
  await notifyDurableAgentEvent(tx, { kind: 'generation-run', runId });
  return last;
}

/** Lock the run row for the lease holder, or refuse a stale worker. */
async function lockLeased(tx: Queryable, lease: RunLease): Promise<RunRow> {
  const locked = await tx.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM generation_runs
      WHERE id = $1 AND lease_worker_id = $2 AND lease_generation = $3
      FOR UPDATE`,
    [lease.runId, lease.workerId, lease.generation],
  );
  const row = locked.rows[0];
  if (!row) throw new GenerationRunLeaseLostError(lease);
  return row;
}

/**
 * Whether the run has media to generate: an item queued (a Retry, or one not
 * reached yet), one a worker was generating, or a video task waiting. Bytes
 * stored for a scene that does not exist yet are no work: they wait for that
 * scene's commit. In a completed run (`stateExpr`, the state the run is left
 * in) stored bytes are work: no scene is coming, and a placement that failed
 * is tried again by the next claim.
 */
const MEDIA_WORK_EXISTS = (runParam: string, stateExpr: string) =>
  `EXISTS (SELECT 1 FROM generation_run_steps s
            WHERE s.run_id = ${runParam} AND s.step_id LIKE '${MEDIA_STEP_PREFIX}%'
              AND (s.output->>'status' IN ('queued', 'generating', 'submitted')
                   OR (s.output->>'status' = 'stored' AND ${stateExpr} = 'completed')))`;

/**
 * Whether the run has media still to generate before it may complete (see
 * {@link MEDIA_WORK_EXISTS}; stored bytes do not hold a completion up), on `tx`.
 */
export async function hasMediaWorkIn(tx: Queryable, runId: string): Promise<boolean> {
  const result = await tx.query<{ pending: boolean }>(
    `SELECT ${MEDIA_WORK_EXISTS('$1', "''")} AS pending`,
    [runId],
  );
  return result.rows[0]?.pending === true;
}

/** Apply a patch to the locked row; answers the updated row. */
async function applyPatch(
  tx: Queryable,
  runId: string,
  patch: RunPatch,
  { resetTakeovers }: { resetTakeovers: boolean },
): Promise<RunRow> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [runId];
  const set = (column: string, value: unknown, cast = '') => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };
  if (patch.state !== undefined) set('state', patch.state);
  const stateParam = params.length;
  if (patch.outlineAutoConfirm) {
    params.push(OUTLINE_AUTO_CONFIRM_MS);
    sets.push(
      `outline_auto_confirm_at = CASE WHEN input->>'outlineReview' = 'countdown'
         THEN now() + make_interval(secs => $${params.length}::double precision / 1000)
         ELSE NULL END`,
    );
  } else if (patch.state !== undefined) {
    sets.push('outline_auto_confirm_at = NULL');
  }
  if (patch.step !== undefined) set('step', patch.step);
  if (patch.outline !== undefined) set('outline', encodeJson(patch.outline, 'outline'), '::jsonb');
  if (patch.outlineRevision !== undefined) set('outline_revision', patch.outlineRevision);
  if (patch.agents !== undefined) set('agents', encodeJson(patch.agents, 'agents'), '::jsonb');
  if (patch.stageId !== undefined) set('stage_id', patch.stageId);
  if (patch.scenesTotal !== undefined) set('scenes_total', patch.scenesTotal);
  if (patch.scenesCompleted !== undefined) set('scenes_completed', patch.scenesCompleted);
  if (patch.narrationUnvoiced) {
    params.push(patch.narrationUnvoiced);
    sets.push(`narration_unvoiced = narration_unvoiced + $${params.length}`);
  }
  if (patch.error !== undefined) {
    set('error', patch.error === null ? null : encodeJson(patch.error, 'error'), '::jsonb');
  }
  if (patch.releaseLease) {
    sets.push('lease_worker_id = NULL', 'lease_heartbeat_at = NULL');
    // Whoever gives the run up says whether media is left for a claim to do.
    // The state the run is left in: the patch's, else the row's own.
    const leftIn = patch.state !== undefined ? `$${stateParam}::text` : 'state';
    sets.push(`media_pending = ${MEDIA_WORK_EXISTS('$1', leftIn)}`);
  }
  if (resetTakeovers) sets.push('takeovers = 0');
  const updated = await tx.query<RunRow>(
    `UPDATE generation_runs SET ${sets.join(', ')} WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
    params,
  );
  return updated.rows[0]!;
}

export interface CreateRunOptions {
  maxActiveRunsPerOwner: number;
  /** Runs one owner may have waiting for outline confirmation at once. */
  maxWaitingRunsPerOwner: number;
}

/** The owner already has as many runs waiting for outline confirmation as allowed. */
export class WaitingRunLimitError extends Error {
  constructor(readonly limit: number) {
    super(
      `At most ${limit} course${limit === 1 ? '' : 's'} may wait for an outline confirmation at ` +
        'once; confirm or discard one and try again.',
    );
    this.name = 'WaitingRunLimitError';
  }
}

/**
 * Serialize the owner's starts and confirmations, then refuse one more run in
 * a limited state when the owner already has `limit` of them. The lock comes
 * first in the transaction, before any run row.
 */
async function enforceActiveRunLimitIn(
  tx: Queryable,
  ownerId: string,
  limit: number,
): Promise<string> {
  // Counted for the owner the runs belong to now: every owner claimed into it
  // shares its limit, and its lock.
  const owner = await canonicalOwnerIn(tx, ownerId);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `openmaic.generation-runs.owner:${owner}`,
  ]);
  const active = await tx.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM generation_runs
      WHERE ${OWNED_BY('$1')} AND state = ANY($2::text[])`,
    [owner, [...LIMITED_RUN_STATES]],
  );
  if (Number(active.rows[0]?.n ?? 0) >= limit) throw new ActiveRunLimitError(limit);
  return owner;
}

/** {@link currentOwnerOf}, on an open transaction. */
async function canonicalOwnerIn(tx: Queryable, ownerId: string): Promise<string> {
  let current = ownerId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    const merged = await tx.query<{ to_owner_id: string }>(
      'SELECT to_owner_id FROM owner_merges WHERE from_owner_id = $1',
      [current],
    );
    const next = merged.rows[0]?.to_owner_id;
    if (!next) return current;
    current = next;
  }
  throw new Error(`The claims of owner ${ownerId} form a chain longer than ${MAX_MERGE_HOPS}`);
}

/**
 * Create a run in `preparing`, refused with {@link ActiveRunLimitError` when
 * the owner already has the limit's worth of active runs. Decided under a
 * per-owner transaction lock, so two starts at the limit cannot both land.
 */
export async function createGenerationRun(
  ownerId: string,
  input: GenerationRunInput,
  options: CreateRunOptions,
): Promise<StoredRun> {
  const { withTransaction } = await provider();
  return withTransaction(async (tx) => {
    const owner = await enforceActiveRunLimitIn(tx, ownerId, options.maxActiveRunsPerOwner);
    const waiting = await tx.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM generation_runs
        WHERE ${OWNED_BY('$1')} AND state = 'awaiting_outline_confirmation'`,
      [owner],
    );
    if (Number(waiting.rows[0]?.n ?? 0) >= options.maxWaitingRunsPerOwner) {
      throw new WaitingRunLimitError(options.maxWaitingRunsPerOwner);
    }
    const id = generateRunId();
    await tx.query(
      `INSERT INTO generation_runs (id, owner_id, input, state)
       VALUES ($1, $2, $3::jsonb, 'preparing')`,
      [id, ownerId, encodeJson(input, 'run input')],
    );
    await insertEvents(tx, id, [{ type: 'state', data: { state: 'preparing', step: null } }]);
    await notifyOwner(tx, ownerId);
    const row = await tx.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM generation_runs WHERE id = $1`, [
      id,
    ]);
    return storedRun(row.rows[0]!);
  });
}

/**
 * The run and its media checkpoints, for its owner, read in one statement
 * (one snapshot); null for an unknown run and for another owner's alike.
 */
/** What a run's own snapshot adds from its event log (see `readGenerationRunWithMedia`). */
export interface RunLogDetails {
  /** The seq of the failure a paused run stopped at: the identity of that failure. */
  failureSeq: number | null;
  /** By element id, the seq of the media item's latest failure (or skip). */
  mediaFailureSeqs: Record<string, number>;
  /** What `material_kinds` said, when the run analyzed materials. */
  materialKinds: Array<'document' | 'media'> | null;
  /** What `material_truncated` said, when the materials were cut. */
  materialTruncated: Record<string, unknown> | null;
}

export async function readGenerationRunWithMedia(
  runId: string,
  ownerId: string,
): Promise<{
  run: StoredRun;
  media: Map<string, GenerationRunMediaCheckpoint>;
  details: RunLogDetails;
} | null> {
  const { pool } = await provider();
  const result = await pool.query<
    RunRow & {
      media: Record<string, GenerationRunMediaCheckpoint>;
      failure_seq: string | null;
      media_failure_seqs: Record<string, string | number>;
      material_kinds: { kinds?: Array<'document' | 'media'> } | null;
      material_truncated: Record<string, unknown> | null;
    }
  >(
    `SELECT ${RUN_COLUMNS},
            (SELECT COALESCE(jsonb_object_agg(s.step_id, s.output), '{}'::jsonb)
               FROM generation_run_steps s
              WHERE s.run_id = r.id AND s.step_id LIKE '${MEDIA_STEP_PREFIX}%') AS media,
            (SELECT max(e.seq) FROM generation_run_events e
              WHERE e.run_id = r.id AND e.type = 'step_failed'
                AND NOT (e.data ? 'continuing')) AS failure_seq,
            (SELECT COALESCE(jsonb_object_agg(f.element_id, f.seq), '{}'::jsonb)
               FROM (SELECT e.data->>'elementId' AS element_id, max(e.seq) AS seq
                       FROM generation_run_events e
                      WHERE e.run_id = r.id AND e.type = 'media'
                        AND e.data->>'status' IN ('failed', 'disabled')
                      GROUP BY 1) f) AS media_failure_seqs,
            (SELECT e.data FROM generation_run_events e
              WHERE e.run_id = r.id AND e.type = 'material_kinds'
              ORDER BY e.seq DESC LIMIT 1) AS material_kinds,
            (SELECT e.data FROM generation_run_events e
              WHERE e.run_id = r.id AND e.type = 'material_truncated'
              ORDER BY e.seq DESC LIMIT 1) AS material_truncated
       FROM generation_runs r WHERE id = $1 AND ${OWNED_BY('$2')}`,
    [runId, ownerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    run: storedRun(row),
    media: new Map(
      Object.entries(row.media).map(([stepId, output]) => [
        stepId.slice(MEDIA_STEP_PREFIX.length),
        output,
      ]),
    ),
    details: {
      failureSeq: row.failure_seq === null ? null : Number(row.failure_seq),
      mediaFailureSeqs: Object.fromEntries(
        Object.entries(row.media_failure_seqs).map(([id, seq]) => [id, Number(seq)]),
      ),
      materialKinds: row.material_kinds?.kinds ?? null,
      materialTruncated: row.material_truncated,
    },
  };
}

/**
 * The last commit of a paused or completed run's media-only execution: its
 * checkpoints, and the lease given up, unless a command made the run
 * executable meanwhile (a step Retry), in which case the holder keeps the
 * lease and goes on with the run. Answers the run as committed.
 */
export async function finishMediaOnlyRun(
  lease: RunLease,
  steps: NonNullable<StepCommit['steps']>,
  events: NewGenerationRunEvent[],
): Promise<StoredRun> {
  const { withTransaction } = await provider();
  return withTransaction(async (tx) => {
    const locked = await lockLeased(tx, lease);
    const executable = (EXECUTABLE_RUN_STATES as readonly string[]).includes(locked.state);
    return commitGenerationRunIn(tx, lease, {
      steps,
      events,
      ...(executable ? {} : { patch: { releaseLease: true } }),
    });
  });
}

/** The run, for its owner; null for an unknown run and for another owner's alike. */
export async function readGenerationRun(runId: string, ownerId: string): Promise<StoredRun | null> {
  const { pool } = await provider();
  const result = await pool.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM generation_runs WHERE id = $1 AND ${OWNED_BY('$2')}`,
    [runId, ownerId],
  );
  const row = result.rows[0];
  return row ? storedRun(row) : null;
}

/** The owner's runs that are not completed or ended, oldest first. */
export async function listActiveGenerationRuns(ownerId: string): Promise<StoredRun[]> {
  const { pool } = await provider();
  const result = await pool.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM generation_runs
      WHERE ${OWNED_BY('$1')} AND state = ANY($2::text[])
      ORDER BY created_at, id`,
    [ownerId, [...ACTIVE_RUN_STATES]],
  );
  return result.rows.map(storedRun);
}

/** The owner's runs changed after `since` (any state), for the owner stream. */
export async function listGenerationRunsUpdatedSince(
  ownerId: string,
  since: Date,
): Promise<StoredRun[]> {
  const { pool } = await provider();
  const result = await pool.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM generation_runs
      WHERE ${OWNED_BY('$1')} AND updated_at > $2
      ORDER BY updated_at, id`,
    [ownerId, since],
  );
  return result.rows.map(storedRun);
}

/** The run's events after `afterSeq`, in order. The caller has checked ownership. */
export async function readGenerationRunEvents(
  runId: string,
  afterSeq: number,
  limit = 500,
): Promise<GenerationRunEvent[]> {
  const { pool } = await provider();
  const result = await pool.query<{
    run_id: string;
    seq: string | number;
    ts: string | number;
    type: GenerationRunEvent['type'];
    data: Record<string, unknown>;
  }>(
    `SELECT run_id, seq, ts, type, data FROM generation_run_events
      WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [runId, afterSeq, limit],
  );
  return result.rows.map((row) => ({
    runId: row.run_id,
    seq: Number(row.seq),
    ts: Number(row.ts),
    type: row.type,
    data: row.data,
  }));
}

export interface ClaimedRun {
  run: StoredRun;
  lease: RunLease;
  /** The previous worker died holding the run (its lease went stale). */
  takeover: boolean;
}

export interface ClaimOptions {
  leaseTtlMs: number;
  maxTakeovers: number;
  /** Claim this run only. */
  runId?: string;
}

/**
 * Claim the oldest executable run nobody holds (a fresh one, one a command
 * released, or one whose worker's lease went stale), or a paused or completed
 * one with media left to generate. Each claim bumps the lease generation,
 * which fences every write of the previous holder. A run whose step was
 * orphaned more than `maxTakeovers` times in a row is paused there instead of
 * being claimed again (a paused or completed run's media fails instead).
 */
export async function claimNextGenerationRun(
  workerId: string,
  options: ClaimOptions,
): Promise<ClaimedRun | null> {
  const { pool, withTransaction } = await provider();
  const staleBefore = Date.now() - options.leaseTtlMs;
  const executable = [...EXECUTABLE_RUN_STATES];
  const claimable = `(state = ANY($1::text[]) OR (media_pending AND state IN ('paused', 'completed')))
    AND (lease_worker_id IS NULL OR lease_heartbeat_at IS NULL OR lease_heartbeat_at < $2)`;
  const targeted = options.runId ? ' AND id = $3' : '';
  const params: unknown[] = [executable, staleBefore, ...(options.runId ? [options.runId] : [])];
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM generation_runs WHERE ${claimable}${targeted} ORDER BY updated_at LIMIT 5`,
    params,
  );
  for (const candidate of candidates.rows) {
    const claimed = await withTransaction(async (tx): Promise<ClaimedRun | null> => {
      const locked = await tx.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM generation_runs
          WHERE id = $3 AND ${claimable}
          FOR UPDATE SKIP LOCKED`,
        [executable, staleBefore, candidate.id],
      );
      const previous = locked.rows[0];
      if (!previous) return null;
      const takeover = previous.lease_worker_id !== null;
      const mediaOnly = previous.state === 'paused' || previous.state === 'completed';
      if (takeover && previous.takeovers >= options.maxTakeovers && mediaOnly) {
        // Its media work keeps killing workers: that media fails (with a
        // Retry), and the run stays as it was.
        await failMediaWorkIn(
          tx,
          previous.id,
          'The media generation was interrupted too many times',
          {
            includeStored: previous.state === 'completed',
          },
        );
        await applyPatch(tx, previous.id, { releaseLease: true }, { resetTakeovers: true });
        await notifyOwner(tx, previous.owner_id);
        return null;
      }
      if (takeover && previous.takeovers >= options.maxTakeovers) {
        // The step's worker died this many times in a row: pausing lets the
        // owner retry it deliberately instead of crashing workers forever.
        // A worker that died before it chose a step leaves no step: retry
        // then resumes the run in the state it was executing.
        const failure: GenerationRunFailure = {
          step: previous.step,
          message: 'The step was interrupted too many times',
          errorCode: 'INTERNAL_ERROR',
          ...(previous.step ? {} : { resumeState: previous.state as ExecutableRunState }),
        };
        await applyPatch(
          tx,
          previous.id,
          { state: 'paused', step: previous.step, error: failure, releaseLease: true },
          { resetTakeovers: true },
        );
        await insertEvents(tx, previous.id, [
          { type: 'step_failed', data: { ...failure } },
          { type: 'state', data: { state: 'paused', step: failure.step } },
        ]);
        await notifyOwner(tx, previous.owner_id);
        return null;
      }
      const updated = await tx.query<RunRow>(
        `UPDATE generation_runs
            SET lease_worker_id = $2, lease_heartbeat_at = $3,
                lease_generation = lease_generation + 1,
                takeovers = takeovers + $4, updated_at = now()
          WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
        [previous.id, workerId, Date.now(), takeover ? 1 : 0],
      );
      const row = updated.rows[0]!;
      return {
        run: storedRun(row),
        lease: { runId: row.id, workerId, generation: row.lease_generation },
        takeover,
      };
    });
    if (claimed) return claimed;
  }
  return null;
}

/**
 * Fail every media item of a run still in work, with events (the run row is
 * locked); `stored` bytes fail too when `includeStored` (a completed run has
 * no scene left to place them with).
 */
async function failMediaWorkIn(
  tx: Queryable,
  runId: string,
  message: string,
  { includeStored }: { includeStored: boolean },
): Promise<void> {
  const statuses = ['queued', 'generating', 'submitted', ...(includeStored ? ['stored'] : [])];
  const pending = await tx.query<{ step_id: string; output: GenerationRunMediaCheckpoint }>(
    `SELECT step_id, output FROM generation_run_steps
      WHERE run_id = $1 AND step_id LIKE '${MEDIA_STEP_PREFIX}%'
        AND output->>'status' = ANY($2::text[])
      ORDER BY step_id`,
    [runId, statuses],
  );
  const events: NewGenerationRunEvent[] = [];
  for (const { step_id: stepId, output } of pending.rows) {
    const failed: GenerationRunMediaCheckpoint = {
      mediaType: output.mediaType,
      status: 'failed',
      message,
    };
    await upsertStep(tx, runId, { id: stepId, output: failed });
    events.push({
      type: 'media',
      data: {
        elementId: stepId.slice(MEDIA_STEP_PREFIX.length),
        mediaType: output.mediaType,
        status: 'failed',
        message,
        retryable: true,
      },
    });
  }
  await insertEvents(tx, runId, events);
}

/** The state a run is in now, or null for none (the runner's own reads). */
export async function readGenerationRunState(runId: string): Promise<GenerationRunState | null> {
  const { pool } = await provider();
  const result = await pool.query<{ state: GenerationRunState }>(
    'SELECT state FROM generation_runs WHERE id = $1',
    [runId],
  );
  return result.rows[0]?.state ?? null;
}

/** Refresh the lease; false once it is no longer held. */
export async function heartbeatGenerationRun(lease: RunLease): Promise<boolean> {
  const { pool } = await provider();
  const result = await pool.query(
    `UPDATE generation_runs SET lease_heartbeat_at = $4
      WHERE id = $1 AND lease_worker_id = $2 AND lease_generation = $3`,
    [lease.runId, lease.workerId, lease.generation, Date.now()],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Give the run up without a commit (the process is shutting down, or the
 * claim is handed back): the next claim resumes it from its last checkpoint.
 * `undoTakeover` takes back the takeover the claim counted, for a claim
 * handed back unused.
 */
export async function releaseGenerationRunLease(
  lease: RunLease,
  { undoTakeover = false }: { undoTakeover?: boolean } = {},
): Promise<void> {
  const { pool } = await provider();
  await pool.query(
    `UPDATE generation_runs
        SET lease_worker_id = NULL, lease_heartbeat_at = NULL,
            takeovers = CASE WHEN $4::boolean THEN greatest(takeovers - 1, 0) ELSE takeovers END
      WHERE id = $1 AND lease_worker_id = $2 AND lease_generation = $3`,
    [lease.runId, lease.workerId, lease.generation, undoTakeover],
  );
}

/** The checkpoints of every completed step, by step id. */
export async function readGenerationRunSteps(runId: string): Promise<Map<string, unknown>> {
  const { pool } = await provider();
  const result = await pool.query<{ step_id: string; output: unknown }>(
    'SELECT step_id, output FROM generation_run_steps WHERE run_id = $1',
    [runId],
  );
  return new Map(result.rows.map((row) => [row.step_id, row.output]));
}

async function upsertStep(
  tx: Queryable,
  runId: string,
  checkpoint: { id: string; output: unknown },
): Promise<void> {
  await tx.query(
    `INSERT INTO generation_run_steps (run_id, step_id, output) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (run_id, step_id) DO UPDATE SET output = EXCLUDED.output, completed_at = now()`,
    [runId, checkpoint.id, encodeJson(checkpoint.output ?? null, 'step output')],
  );
}

/**
 * One fenced commit on `tx`, an open transaction: the step's checkpoint, the
 * run's next state and the events that report both, refused with
 * {@link GenerationRunLeaseLostError} for a worker that no longer holds the
 * run. Answers the run as committed.
 */
export async function commitGenerationRunIn(
  tx: Queryable,
  lease: RunLease,
  commit: StepCommit,
): Promise<StoredRun> {
  const before = await lockLeased(tx, lease);
  const checkpoints = [...(commit.step ? [commit.step] : []), ...(commit.steps ?? [])];
  for (const checkpoint of checkpoints) {
    await upsertStep(tx, lease.runId, checkpoint);
  }
  let row = await applyPatch(tx, lease.runId, commit.patch ?? {}, {
    resetTakeovers: checkpoints.length > 0,
  });
  const events = [...(commit.events ?? [])];
  if (commit.patch?.outlineAutoConfirm && row.outline_auto_confirm_at) {
    events.push({
      type: 'outline_review',
      data: {
        outlineReview: 'countdown',
        autoConfirmAt: isoTimestamp(row.outline_auto_confirm_at),
      },
    });
  }
  if (events.length) {
    await insertEvents(tx, lease.runId, events);
    row = { ...row, seq: Number(row.seq) + events.length };
  }
  if (
    (commit.patch?.state === 'completed' || commit.patch?.state === 'ended') &&
    commit.patch.state !== before.state
  ) {
    await releaseRunMaterialsIn(tx, lease.runId);
  }
  if (commit.patch?.state !== undefined && commit.patch.state !== before.state) {
    await notifyOwner(tx, before.owner_id);
  } else if (commit.patch?.scenesCompleted !== undefined || commit.patch?.stageId !== undefined) {
    // Course cards show the progress and link the course.
    await notifyOwner(tx, before.owner_id);
  }
  return storedRun(row);
}

/** {@link commitGenerationRunIn} in a transaction of its own. */
export async function commitGenerationRun(lease: RunLease, commit: StepCommit): Promise<StoredRun> {
  const { withTransaction } = await provider();
  return withTransaction((tx) => commitGenerationRunIn(tx, lease, commit));
}

/**
 * The fence of a write the run makes outside its own rows (a document write,
 * an asset allocation), inside that write's transaction: refused with
 * {@link GenerationRunLeaseLostError} once the worker no longer holds the run.
 *
 * It locks the course's ownership row first, then the run row, in the order
 * a course deletion takes them (the deletion ends the course's runs in its
 * own transaction), so the two can never wait on each other in a cycle.
 */
export async function fenceGenerationRunWriteIn(
  tx: Queryable,
  lease: RunLease,
  stageId?: string,
): Promise<void> {
  if (stageId) {
    await tx.query('SELECT 1 FROM stage_meta WHERE stage_id = $1 FOR UPDATE', [stageId]);
  }
  await lockLeased(tx, lease);
}

/** The code a write into a course whose run is still generating it is refused with. */
export const COURSE_GENERATING = 'COURSE_GENERATING';

/**
 * A write into a course that a generation run is still producing: the course
 * is read-only to every other writer (the classroom editor, the Pro agent)
 * until its run completes or ends. A {@link DocumentWriteRefusedError}, so
 * every path that turns a refused document write into a response does so.
 */
export class CourseGeneratingError extends DocumentWriteRefusedError {
  constructor(stageId: string) {
    super(
      stageId,
      COURSE_GENERATING,
      'This course is still being generated; it can be edited once its generation completes.',
    );
  }
}

export function isCourseGeneratingError(error: unknown): boolean {
  return error instanceof DocumentWriteRefusedError && error.code === COURSE_GENERATING;
}

/**
 * Refuse a write into `stageId` while a run is producing the course: its
 * state is not completed or ended (its first media pass included, which
 * completion waits for). A completed run regenerating one retried image or
 * video does not lock the course: that write is a targeted read-modify-write
 * of the current document. `writerRunId` is the run making the write, whose
 * own (lease-fenced) writes go through. Called on the write's transaction with the course's
 * ownership row locked, which every run commit that touches the course locks
 * too, so the answer holds until the write commits. A no-op on a database
 * whose run tables do not exist yet.
 */
export async function assertCourseWritableIn(
  tx: Queryable,
  stageId: string,
  writerRunId?: string,
): Promise<void> {
  const provisioned = await tx.query<{ present: string | null }>(
    "SELECT to_regclass('generation_runs')::text AS present",
  );
  if (!provisioned.rows[0]?.present) return;
  const producing = await tx.query<{ id: string }>(
    `SELECT id FROM generation_runs
      WHERE stage_id = $1 AND id IS DISTINCT FROM $2
        AND state NOT IN ('completed', 'ended')
      LIMIT 1`,
    [stageId, writerRunId ?? null],
  );
  if (producing.rows.length > 0) throw new CourseGeneratingError(stageId);
}

/** A run's media checkpoints, by element id. The caller has checked ownership. */
export async function readGenerationRunMedia(
  runId: string,
): Promise<Map<string, GenerationRunMediaCheckpoint>> {
  const { pool } = await provider();
  const result = await pool.query<{ step_id: string; output: GenerationRunMediaCheckpoint }>(
    `SELECT step_id, output FROM generation_run_steps
      WHERE run_id = $1 AND step_id LIKE '${MEDIA_STEP_PREFIX}%'`,
    [runId],
  );
  return new Map(
    result.rows.map((row) => [row.step_id.slice(MEDIA_STEP_PREFIX.length), row.output]),
  );
}

/**
 * End every unfinished run of a course, on the transaction that deletes it
 * (`deleteDocument` of the owner-bound document store), whatever state the
 * run is in, and a completed one that still has media to generate. A worker
 * executing one loses its lease with it. A no-op on a
 * database whose run tables do not exist yet.
 */
export async function endGenerationRunsOfDeletedCourseIn(
  tx: Queryable,
  stageId: string,
): Promise<void> {
  const provisioned = await tx.query<{ present: string | null }>(
    "SELECT to_regclass('generation_runs')::text AS present",
  );
  if (!provisioned.rows[0]?.present) return;
  const runs = await tx.query<{ id: string; owner_id: string }>(
    `SELECT id, owner_id FROM generation_runs
      WHERE stage_id = $1
        AND (state NOT IN ('completed', 'ended') OR (state = 'completed' AND media_pending))
      ORDER BY id FOR UPDATE`,
    [stageId],
  );
  for (const run of runs.rows) {
    await endRunIn(tx, run.id, run.owner_id, { stageId });
  }
}

/**
 * Release the materials a run was started with when its input asks for it
 * (`releaseMaterials`: the composer uploaded them for this run only), once the
 * run is over: marked deleted, as the material delete path marks them, so
 * they stop resolving and counting against the owner's quota; their bytes go
 * with the owner's next reclaim sweep (`reclaimStaleOwnerMaterialUploads`).
 * Only materials the run's owner owns and no other of the owner's runs that
 * is not over names; the course assets copied from their images are the
 * course's and stay. Idempotent.
 */
export async function releaseRunMaterialsIn(tx: Queryable, runId: string): Promise<number> {
  const provisioned = await tx.query<{ present: string | null }>(
    "SELECT to_regclass('owner_material')::text AS present",
  );
  if (!provisioned.rows[0]?.present) return 0;
  const released = await tx.query<{ id: string }>(
    `UPDATE owner_material m
        SET deleted_at = $2
       FROM generation_runs r
      WHERE r.id = $1
        AND r.input->>'releaseMaterials' = 'true'
        AND m.id IN (SELECT jsonb_array_elements_text(r.input->'materialIds'))
        AND m.owner_id = r.owner_id
        AND m.status = 'ready'
        AND m.deleted_at IS NULL
        -- Another run of the owner still working from it keeps it.
        AND NOT EXISTS (
          SELECT 1 FROM generation_runs o
           WHERE o.id <> r.id
             AND o.owner_id = r.owner_id
             AND o.state NOT IN ('completed', 'ended')
             AND o.input->'materialIds' ? m.id
        )
      RETURNING m.id`,
    [runId, Date.now()],
  );
  return released.rows.length;
}

/** End a run (its course is gone or was never made), fencing whoever held it. */
async function endRunIn(
  tx: Queryable,
  runId: string,
  ownerId: string,
  data: { stageId: string | null },
): Promise<number> {
  await tx.query(
    `UPDATE generation_runs
        SET state = 'ended', step = NULL, error = NULL, media_pending = false,
            lease_worker_id = NULL, lease_heartbeat_at = NULL,
            lease_generation = lease_generation + 1, updated_at = now()
      WHERE id = $1`,
    [runId],
  );
  const seq = await insertEvents(tx, runId, [
    { type: 'ended', data },
    { type: 'state', data: { state: 'ended', step: null } },
  ]);
  // What the run kept alive and no course names is released now.
  await setRunPendingAssetDeadlineIn(tx, 'r.id = $1', [runId], 'now()');
  await releaseRunMaterialsIn(tx, runId);
  await notifyOwner(tx, ownerId);
  return seq;
}

/**
 * Set the pending deadline of the allocations runs hold in their checkpoints
 * (material images, media stored for a scene not written yet) that no
 * document has committed: the runs `runFilter` selects (on `generation_runs r`).
 */
async function setRunPendingAssetDeadlineIn(
  tx: Queryable,
  runFilter: string,
  params: unknown[],
  deadline: string,
): Promise<number> {
  const provisioned = await tx.query<{ present: string | null }>(
    "SELECT to_regclass('asset_entries')::text AS present",
  );
  if (!provisioned.rows[0]?.present) return 0;
  const updated = await tx.query<{ id: string }>(
    `WITH held AS (
       SELECT s.output FROM generation_run_steps s JOIN generation_runs r ON r.id = s.run_id
        WHERE ${runFilter}
          AND (s.step_id = 'material-analysis' OR s.step_id LIKE '${MEDIA_STEP_PREFIX}%')
     ), ids AS (
       SELECT mapping.value AS id
         FROM held, jsonb_each_text(COALESCE(held.output->'imageMapping', '{}'::jsonb)) AS mapping
       UNION SELECT held.output->>'assetId' FROM held WHERE held.output->>'status' = 'stored'
       UNION SELECT held.output->>'posterAssetId' FROM held WHERE held.output->>'status' = 'stored'
     ), targets AS (
       -- Locked in id order, the order every multi-entry asset write takes
       -- (an owner claim re-keying entries), so the two cannot deadlock.
       SELECT e.id FROM asset_entries e
        WHERE e.committed_at IS NULL AND e.expires_at IS NOT NULL
          AND e.id IN (SELECT id FROM ids WHERE id IS NOT NULL)
        ORDER BY e.id
          FOR UPDATE
     )
     UPDATE asset_entries SET expires_at = ${deadline.replaceAll('expires_at', 'asset_entries.expires_at')}
       FROM targets WHERE asset_entries.id = targets.id
     RETURNING asset_entries.id`,
    params,
  );
  return updated.rows.length;
}

/**
 * Keep the allocations live runs hold from expiring: their pending deadline
 * moves `ttlMs` ahead. A run's material images and the media it stored wait
 * for a scene that may come much later (an outline waiting for its
 * confirmation, a paused run retried days later). Answers how many it kept.
 */
export async function keepGenerationRunAssetsAlive(ttlMs: number): Promise<number> {
  const { withTransaction } = await provider();
  return withTransaction((tx) =>
    setRunPendingAssetDeadlineIn(
      tx,
      `(r.state NOT IN ('completed', 'ended') OR r.media_pending)`,
      [ttlMs / 1000],
      'greatest(expires_at, now() + make_interval(secs => $1))',
    ),
  );
}

export interface CommandResult {
  state: GenerationRunState;
  seq: number;
  outlineRevision?: number;
}

/**
 * Run `apply` once per `commandId`: a command id seen before answers the
 * result recorded the first time (for the same command type), without
 * applying anything again. Only a command that applied is recorded, so a
 * refused one may be sent again once the run allows it.
 */
async function runCommand(
  runId: string,
  ownerId: string,
  commandId: string,
  type: 'confirm-outline' | 'hold-outline' | 'retry' | 'discard',
  apply: (tx: Queryable, run: RunRow, refusal: unknown) => Promise<CommandResult>,
  /** Runs first in the transaction, before the run row is locked. */
  before?: (tx: Queryable) => Promise<void>,
): Promise<CommandResult | null> {
  const { withTransaction } = await provider();
  return withTransaction(async (tx) => {
    // A lock taken here comes before the run row's, as in a start.
    let refusal: unknown;
    if (before) {
      try {
        await before(tx);
      } catch (error) {
        // Refused only if this command is new (a repeat answers what it did).
        refusal = error;
      }
    }
    const locked = await tx.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM generation_runs WHERE id = $1 AND ${OWNED_BY('$2')} FOR UPDATE`,
      [runId, ownerId],
    );
    const run = locked.rows[0];
    if (!run) return null;
    const seen = await tx.query<{ type: string; result: CommandResult }>(
      'SELECT type, result FROM generation_run_commands WHERE run_id = $1 AND command_id = $2',
      [runId, commandId],
    );
    const previous = seen.rows[0];
    if (previous) {
      if (previous.type !== type) {
        throw new RunCommandConflictError(
          'command-reused',
          `The command id was already used for a ${previous.type} command`,
        );
      }
      return previous.result;
    }
    const result = await apply(tx, run, refusal);
    await tx.query(
      `INSERT INTO generation_run_commands (run_id, command_id, type, result)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [runId, commandId, type, encodeJson(result, 'command result')],
    );
    await notifyOwner(tx, run.owner_id);
    return result;
  });
}

/**
 * Confirm the outline at `outlineRevision`, optionally replacing it with the
 * owner's edit (a new revision). The run goes on generating; nothing holds a
 * worker until then. Null for a run the owner cannot see.
 */
export async function confirmGenerationRunOutline(
  runId: string,
  ownerId: string,
  command: { commandId: string; outlineRevision: number; outlines?: SceneOutline[] },
  /** Confirming makes the run active again: it counts toward the limit from then on. */
  options: { maxActiveRunsPerOwner: number },
): Promise<CommandResult | null> {
  const limit = async (tx: Queryable) => {
    await enforceActiveRunLimitIn(tx, ownerId, options.maxActiveRunsPerOwner);
  };
  return runCommand(
    runId,
    ownerId,
    command.commandId,
    'confirm-outline',
    async (tx, run, refusal) => {
      if (run.state !== 'awaiting_outline_confirmation' || !run.outline) {
        throw new RunCommandConflictError(
          'state',
          `The run is ${run.state.replaceAll('_', ' ')}, not waiting for its outline to be confirmed`,
        );
      }
      if (command.outlineRevision !== run.outline_revision) {
        throw new RunCommandConflictError(
          'outline-revision',
          `The outline is at revision ${run.outline_revision}, not ${command.outlineRevision}`,
        );
      }
      // The run is confirmable: whether the owner may run one more decides.
      if (refusal) throw refusal;
      const edited = command.outlines !== undefined;
      const outline: GenerationRunOutline = edited
        ? { ...run.outline, outlines: command.outlines! }
        : run.outline;
      const revision = edited ? run.outline_revision + 1 : run.outline_revision;
      const updated = await applyPatch(
        tx,
        runId,
        {
          state: 'generating',
          step: null,
          outline,
          outlineRevision: revision,
          scenesTotal: outline.outlines.length,
          releaseLease: true,
        },
        { resetTakeovers: true },
      );
      const seq = await insertEvents(tx, runId, [
        { type: 'outline_confirmed', data: { revision, edited } },
        { type: 'state', data: { state: 'generating', step: null } },
      ]);
      return { state: updated.state, seq, outlineRevision: revision };
    },
    limit,
  );
}

/**
 * Hold a `countdown` run's outline for the owner's review: the run becomes a
 * `wait` one, so it waits for `confirm-outline` instead of confirming its
 * outline itself. Valid until the outline is confirmed: while the outline is
 * being generated (the run then waits once it is ready) and while it waits
 * for its deadline. A `wait` run is held already. Null for a run the owner
 * cannot see.
 */
export async function holdGenerationRunOutline(
  runId: string,
  ownerId: string,
  command: { commandId: string },
): Promise<CommandResult | null> {
  return runCommand(runId, ownerId, command.commandId, 'hold-outline', async (tx, run) => {
    const before =
      run.state === 'awaiting_outline_confirmation' ||
      (!run.outline && ['preparing', 'outlining', 'paused'].includes(run.state));
    if (!before) {
      throw new RunCommandConflictError(
        'state',
        `The run is ${run.state.replaceAll('_', ' ')}: its outline was already confirmed`,
      );
    }
    if (run.input.outlineReview === 'auto') {
      throw new RunCommandConflictError('state', 'The run confirms its own outline');
    }
    if (run.input.outlineReview === 'wait') {
      return { state: run.state, seq: Number(run.seq) };
    }
    const updated = await tx.query<RunRow>(
      `UPDATE generation_runs
          SET input = jsonb_set(input, '{outlineReview}', '"wait"'),
              outline_auto_confirm_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
      [runId],
    );
    const seq = await insertEvents(tx, runId, [
      { type: 'outline_review', data: { outlineReview: 'wait', autoConfirmAt: null } },
    ]);
    return { state: updated.rows[0]!.state, seq };
  });
}

/**
 * Confirm the outlines of the `countdown` runs whose deadline passed, as the
 * run itself (the same commit an `auto` run's outline makes). Any process's
 * runner does it, so a deadline outlives the process that set it. The run
 * was in progress up to its outline, so the per-owner limit does not refuse
 * it. Answers how many it confirmed.
 */
export async function confirmDueGenerationRunOutlines(limit = 10): Promise<number> {
  const { withTransaction } = await provider();
  return withTransaction(async (tx) => {
    const due = await tx.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM generation_runs
        WHERE state = 'awaiting_outline_confirmation'
          AND outline_auto_confirm_at IS NOT NULL AND outline_auto_confirm_at <= now()
        ORDER BY outline_auto_confirm_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const run of due.rows) {
      await applyPatch(
        tx,
        run.id,
        { state: 'generating', step: null, releaseLease: true },
        { resetTakeovers: true },
      );
      await insertEvents(tx, run.id, [
        {
          type: 'outline_confirmed',
          data: { revision: run.outline_revision, edited: false, automatic: true },
        },
        { type: 'state', data: { state: 'generating', step: null } },
      ]);
      await notifyOwner(tx, run.owner_id);
    }
    return due.rows.length;
  });
}

/**
 * Re-run the step a paused run stopped at, or, with `media`, generate one
 * failed image or video again (the run may be generating, paused or
 * completed; nothing else of it runs again). Null for a run the owner cannot
 * see.
 */
export async function retryGenerationRun(
  runId: string,
  ownerId: string,
  command: { commandId: string; media?: { elementId: string } },
  /**
   * A step Retry makes a paused run active again: it counts toward the limit
   * from then on. A media Retry does not change the run's state.
   */
  options: { maxActiveRunsPerOwner: number } = {
    maxActiveRunsPerOwner: generationRunConfig().maxActiveRunsPerOwner,
  },
): Promise<CommandResult | null> {
  const limit = command.media
    ? undefined
    : async (tx: Queryable) => {
        await enforceActiveRunLimitIn(tx, ownerId, options.maxActiveRunsPerOwner);
      };
  return runCommand(
    runId,
    ownerId,
    command.commandId,
    'retry',
    async (tx, run, refusal) => {
      if (command.media) return retryMediaIn(tx, run, command.media.elementId);
      if (run.state !== 'paused') {
        throw new RunCommandConflictError(
          'state',
          `The run is ${run.state.replaceAll('_', ' ')}, not paused`,
        );
      }
      // The run is retryable: whether the owner may run one more decides.
      if (refusal) throw refusal;
      // A run paused at its materials failed with an extraction's error:
      // Retry extracts the failed ones again.
      if (run.step === 'material-analysis') {
        await restartFailedRunMaterialExtractionsIn(tx, run.owner_id, run.input.materialIds);
      }
      // A run paused before it chose a step resumes where it was executing.
      const state = run.step
        ? stateForRetry(run.step)
        : (run.error?.resumeState ?? (run.outline ? 'generating' : 'preparing'));
      const updated = await applyPatch(
        tx,
        runId,
        // No lease is taken from a worker that holds the run (one generating a
        // paused run's media): it sees the state when it finishes and goes on
        // with the run itself. A run nobody holds is claimable as it is.
        { state, error: null },
        { resetTakeovers: true },
      );
      const seq = await insertEvents(tx, runId, [
        { type: 'state', data: { state, step: run.step } },
      ]);
      return { state: updated.state, seq };
    },
    limit,
  );
}

/**
 * Start the failed extractions of a run's materials again, only among the
 * materials its owner holds now (a claim moves them to the account; a no-op
 * without the table).
 */
async function restartFailedRunMaterialExtractionsIn(
  tx: Queryable,
  storedOwnerId: string,
  materialIds: readonly string[],
): Promise<void> {
  if (materialIds.length === 0) return;
  const provisioned = await tx.query<{ present: string | null }>(
    "SELECT to_regclass('owner_material')::text AS present",
  );
  if (!provisioned.rows[0]?.present) return;
  let owner = storedOwnerId;
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop += 1) {
    const merged = await tx.query<{ to_owner_id: string }>(
      'SELECT to_owner_id FROM owner_merges WHERE from_owner_id = $1',
      [owner],
    );
    const next = merged.rows[0]?.to_owner_id;
    if (!next) break;
    owner = next;
  }
  await startOwnerMaterialExtractions(tx, owner, materialIds, ['failed']);
}

/** Queue one failed media item of a run again (the run row is locked). */
async function retryMediaIn(tx: Queryable, run: RunRow, elementId: string): Promise<CommandResult> {
  if (run.state !== 'generating' && run.state !== 'paused' && run.state !== 'completed') {
    throw new RunCommandConflictError(
      'state',
      `The run is ${run.state.replaceAll('_', ' ')}; its media can no longer be generated`,
    );
  }
  const found = await tx.query<{ output: GenerationRunMediaCheckpoint }>(
    'SELECT output FROM generation_run_steps WHERE run_id = $1 AND step_id = $2',
    [run.id, mediaStepId(elementId)],
  );
  const media = found.rows[0]?.output;
  if (!media) {
    throw new RunCommandConflictError('media', `The run has no media element ${elementId}`);
  }
  const retryable =
    media.status === 'skipped' || (media.status === 'failed' && isRetryableRunMedia(media));
  if (!retryable) {
    throw new RunCommandConflictError(
      'media',
      media.status === 'failed'
        ? `The media element ${elementId} failed for a reason Retry cannot change`
        : `The media element ${elementId} has not failed`,
    );
  }
  // Generated anew, as the browser's Retry does (a video submits a new task).
  const queued: GenerationRunMediaCheckpoint = { mediaType: media.mediaType, status: 'queued' };
  await upsertStep(tx, run.id, { id: mediaStepId(elementId), output: queued });
  // A run that is generating takes it up at its next step; a paused or
  // completed one is claimed for it.
  if (run.state !== 'generating') {
    await tx.query(
      'UPDATE generation_runs SET media_pending = true, updated_at = now() WHERE id = $1',
      [run.id],
    );
  }
  const seq = await insertEvents(tx, run.id, [
    { type: 'media', data: { elementId, mediaType: media.mediaType, status: 'pending' } },
  ]);
  return { state: run.state, seq };
}

/**
 * Discard a run that has no course yet: its course card is all there is of
 * the course, and discarding it is deleting that pending course (the run
 * ends, and a worker executing it loses its lease). A run whose course
 * exists ends when the course is deleted instead. Repeating a discard
 * answers the same. Null for a run the owner cannot see.
 */
export async function discardGenerationRun(
  runId: string,
  ownerId: string,
): Promise<CommandResult | null> {
  const { withTransaction } = await provider();
  return withTransaction(async (tx) => {
    const locked = await tx.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM generation_runs WHERE id = $1 AND ${OWNED_BY('$2')} FOR UPDATE`,
      [runId, ownerId],
    );
    const run = locked.rows[0];
    if (!run) return null;
    if (run.stage_id) {
      throw new RunCommandConflictError(
        'course-exists',
        'The run already has its course; delete the course to end the run',
      );
    }
    if (run.state === 'ended') return { state: 'ended', seq: Number(run.seq) };
    if (run.state === 'completed') {
      throw new RunCommandConflictError('state', 'The run is completed');
    }
    const seq = await endRunIn(tx, run.id, run.owner_id, { stageId: null });
    return { state: 'ended', seq };
  });
}
