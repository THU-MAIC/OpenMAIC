/**
 * The render job rows of the durable export queue: admission and upload (the
 * submit route), the owner's reads and cancel (the status, download and cancel
 * routes), and the lease-fenced writes of the runner that dispatches and
 * follows each job. Schema: `lib/persistence/render-jobs.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { Queryable } from '@openmaic/storage/document/pg';
import type { ConnectableQueryable } from '@openmaic/storage/server/reference';

import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import { ensureRenderJobSchema } from '@/lib/persistence/render-jobs';
import { withSchemaBootstrapLock } from '@/lib/persistence/schema-bootstrap-lock';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export type RenderJobStatus =
  | 'uploading'
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

const UNFINISHED: readonly RenderJobStatus[] = ['uploading', 'queued', 'dispatched', 'running'];
const AT_RENDER: readonly RenderJobStatus[] = ['dispatched', 'running'];

/** One stored part of an archive or MP4: its content hash and size. */
export interface RenderJobPart {
  hash: string;
  bytes: number;
}

export interface RenderJob {
  id: string;
  ownerId: string;
  status: RenderJobStatus;
  inputContentType: string;
  inputParts: RenderJobPart[];
  inputBytes: number;
  outputParts: RenderJobPart[];
  outputBytes: number;
  renderTarget: string | null;
  renderJobId: string | null;
  attempt: number;
  progress: number;
  stage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface RenderJobLease {
  jobId: string;
  workerId: string;
  generation: number;
}

export interface ClaimedRenderJob {
  job: RenderJob;
  lease: RenderJobLease;
}

interface RenderJobRow extends Record<string, unknown> {
  id: string;
  owner_id: string;
  status: RenderJobStatus;
  input_content_type: string;
  input_parts: RenderJobPart[];
  input_bytes: string | number;
  output_parts: RenderJobPart[];
  output_bytes: string | number;
  render_target: string | null;
  render_job_id: string | null;
  attempt: number;
  lease_generation: number;
  progress: number;
  stage: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
}

const COLUMNS = `id, owner_id, status, input_content_type, input_parts,
  input_bytes, output_parts, output_bytes, render_target, render_job_id, attempt,
  lease_generation, progress, stage, error_code, error_message, created_at`;

function renderJob(row: RenderJobRow): RenderJob {
  return {
    id: row.id,
    ownerId: row.owner_id,
    status: row.status,
    inputContentType: row.input_content_type,
    inputParts: row.input_parts,
    inputBytes: Number(row.input_bytes),
    outputParts: row.output_parts,
    outputBytes: Number(row.output_bytes),
    renderTarget: row.render_target,
    renderJobId: row.render_job_id,
    attempt: row.attempt,
    progress: row.progress,
    stage: row.stage,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ids are server-minted UUIDs; anything else names no job. */
export function isRenderJobId(value: string): boolean {
  return UUID.test(value);
}

const SCHEMA_STATE_KEY = Symbol.for('openmaic.render-jobs.schema');
const schemaState = globalThis as typeof globalThis & {
  [SCHEMA_STATE_KEY]?: { connectionString: string; ready: Promise<void> };
};

/** The persistence provider, with `render_jobs` provisioned on first use. */
export async function renderQueuePersistence() {
  const connectionString = process.env.DATABASE_URL ?? '';
  const persistence = await getServerPersistenceProvider(connectionString);
  const cached = schemaState[SCHEMA_STATE_KEY];
  if (!cached || cached.connectionString !== connectionString) {
    const ready = withSchemaBootstrapLock(
      persistence.pool as unknown as ConnectableQueryable,
      ensureRenderJobSchema,
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
export function resetRenderJobSchemaForTests(): void {
  delete schemaState[SCHEMA_STATE_KEY];
}

export type RenderAdmissionRefusal = 'queue_full' | 'per_identity_limit';

/**
 * Admit a job in `uploading`, or refuse it: the deployment already holds
 * `maxJobs` unfinished jobs, or the owner `maxJobsPerOwner`. Admissions are
 * serialized on one advisory lock, so two at once cannot both take the last
 * slot.
 */
export async function createRenderJob(input: {
  ownerId: string;
  inputContentType: string;
  maxJobs: number;
  maxJobsPerOwner: number;
}): Promise<{ id: string } | { refused: RenderAdmissionRefusal }> {
  const { withTransaction } = await renderQueuePersistence();
  return withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, input.ownerId);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('render-jobs.admission', 0))");
    const counts = await tx.query<{ total: string; owned: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE owner_id = $2)::text AS owned
         FROM render_jobs WHERE status = ANY($1::text[])`,
      [UNFINISHED, input.ownerId],
    );
    const { total, owned } = counts.rows[0]!;
    if (Number(total) >= input.maxJobs) return { refused: 'queue_full' as const };
    if (input.maxJobsPerOwner > 0 && Number(owned) >= input.maxJobsPerOwner) {
      return { refused: 'per_identity_limit' as const };
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO render_jobs (id, owner_id, status, input_content_type)
       VALUES ($1, $2, 'uploading', $3)`,
      [id, input.ownerId, input.inputContentType],
    );
    return { id };
  });
}

/** Record an input part before its bytes are written; false once the upload was cancelled. */
export async function recordRenderInputPart(
  jobId: string,
  part: RenderJobPart,
  totalBytes: number,
): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs
        SET input_parts = input_parts || $2::jsonb, input_bytes = $3, updated_at = now()
      WHERE id = $1 AND status = 'uploading'`,
    [jobId, JSON.stringify([part]), totalBytes],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The upload did not complete (too large, empty, or the request broke): the
 * job ends as failed, and the sweep deletes the parts it recorded.
 */
export async function failRenderUpload(
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const { pool } = await renderQueuePersistence();
  await pool.query(
    `UPDATE render_jobs
        SET status = 'failed', error_code = $2, error_message = $3, finished_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'uploading'`,
    [jobId, errorCode, errorMessage],
  );
}

/** The upload is complete: the job joins the queue. False once it was cancelled. */
export async function queueRenderJob(jobId: string): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs SET status = 'queued', updated_at = now()
      WHERE id = $1 AND status = 'uploading'`,
    [jobId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The job, if it exists and belongs to `ownerId`. */
export async function readRenderJob(jobId: string, ownerId: string): Promise<RenderJob | null> {
  if (!isRenderJobId(jobId)) return null;
  const { pool } = await renderQueuePersistence();
  const result = await pool.query<RenderJobRow>(
    `SELECT ${COLUMNS} FROM render_jobs WHERE id = $1 AND owner_id = $2`,
    [jobId, ownerId],
  );
  const row = result.rows[0];
  return row ? renderJob(row) : null;
}

/** Queued jobs ahead of this one, oldest first (0 when it is next). */
export async function renderJobQueuePosition(job: RenderJob): Promise<number> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query<{ ahead: string }>(
    `SELECT count(*)::text AS ahead FROM render_jobs
      WHERE status = 'queued' AND (created_at, id) < ($1::timestamptz, $2::text)`,
    [job.createdAt, job.id],
  );
  return Number(result.rows[0]!.ahead);
}

/** Unfinished jobs across the deployment, for the capability answer. */
export async function countUnfinishedRenderJobs(): Promise<number> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM render_jobs WHERE status = ANY($1::text[])',
    [UNFINISHED],
  );
  return Number(result.rows[0]!.total);
}

/**
 * Cancel the owner's job. An unfinished job becomes `cancelled`; the runner
 * holding a job already sent to the render service cancels it there. A
 * finished job is left as it is. False when the owner has no such job.
 */
export async function cancelRenderJob(jobId: string, ownerId: string): Promise<boolean> {
  if (!isRenderJobId(jobId)) return false;
  const { pool, withTransaction } = await renderQueuePersistence();
  const found = await pool.query('SELECT 1 FROM render_jobs WHERE id = $1 AND owner_id = $2', [
    jobId,
    ownerId,
  ]);
  if (found.rowCount === 0) return false;
  await withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, ownerId);
    await tx.query(
      `UPDATE render_jobs SET status = 'cancelled', finished_at = now(), updated_at = now()
        WHERE id = $1 AND owner_id = $2 AND status = ANY($3::text[])`,
      [jobId, ownerId, UNFINISHED],
    );
  });
  return true;
}

/** Whether a queued job waits for dispatch. */
export async function hasQueuedRenderJob(): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query("SELECT 1 FROM render_jobs WHERE status = 'queued' LIMIT 1");
  return (result.rowCount ?? 0) > 0;
}

/**
 * Claim the oldest job this worker should act on: a queued one (only when
 * `dispatch` says the render service has room), a job at the render service
 * nobody follows (its worker's lease went stale, or was given up), or a job
 * cancelled after it was sent that nobody has cancelled at the render service
 * yet. Each claim bumps the lease
 * generation, which fences every write of the previous holder.
 */
export async function claimRenderJob(
  workerId: string,
  options: { leaseTtlMs: number; dispatch: boolean },
): Promise<ClaimedRenderJob | null> {
  const { withTransaction } = await renderQueuePersistence();
  const staleBefore = Date.now() - options.leaseTtlMs;
  const stale = '(lease_worker_id IS NULL OR lease_heartbeat_at < $1)';
  const claimable = `(
      (status = ANY($2::text[]) AND ${stale})
      OR (status = 'cancelled' AND render_job_id IS NOT NULL AND ${stale})
      OR ($3::boolean AND status = 'queued' AND ${stale}))`;
  return withTransaction(async (tx) => {
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM render_jobs WHERE ${claimable}
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [staleBefore, AT_RENDER, options.dispatch],
    );
    const id = locked.rows[0]?.id;
    if (!id) return null;
    const updated = await tx.query<RenderJobRow>(
      `UPDATE render_jobs
          SET lease_worker_id = $2, lease_heartbeat_at = $3,
              lease_generation = lease_generation + 1, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, workerId, Date.now()],
    );
    const row = updated.rows[0]!;
    return {
      job: renderJob(row),
      lease: { jobId: row.id, workerId, generation: row.lease_generation },
    };
  });
}

const HELD = 'id = $1 AND lease_worker_id = $2 AND lease_generation = $3';
const leaseParams = (lease: RenderJobLease) => [lease.jobId, lease.workerId, lease.generation];

/**
 * Refresh the lease, with the progress the render service reported. Answers
 * the job's status (a `cancelled` one is to be cancelled at the render
 * service), or null once the lease is no longer held.
 */
export async function heartbeatRenderJob(
  lease: RenderJobLease,
  report?: { running: boolean; progress: number; stage: string | null },
): Promise<RenderJobStatus | null> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query<{ status: RenderJobStatus }>(
    `UPDATE render_jobs
        SET lease_heartbeat_at = $4,
            status = CASE WHEN $5::boolean AND status = 'dispatched' THEN 'running' ELSE status END,
            progress = CASE WHEN status = ANY($6::text[]) THEN COALESCE($7, progress) ELSE progress END,
            stage = CASE WHEN status = ANY($6::text[]) AND $5::boolean IS NOT NULL THEN $8 ELSE stage END
      WHERE ${HELD} RETURNING status`,
    [
      ...leaseParams(lease),
      Date.now(),
      report ? report.running : null,
      AT_RENDER,
      report ? report.progress : null,
      report?.stage ?? null,
    ],
  );
  return result.rows[0]?.status ?? null;
}

/**
 * Count a dispatch before the archive is sent: a worker that dies after the
 * render service accepted the job but before it recorded the id leaves the
 * job queued, and the next dispatch counts as another attempt. Answers the
 * attempt this dispatch is, or null once the lease or job is gone.
 */
export async function beginRenderJobDispatch(lease: RenderJobLease): Promise<number | null> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query<{ attempt: number }>(
    `UPDATE render_jobs SET attempt = attempt + 1, updated_at = now()
      WHERE ${HELD} AND status = 'queued' RETURNING attempt`,
    leaseParams(lease),
  );
  return result.rows[0]?.attempt ?? null;
}

/** The render service certainly did not take the job: the dispatch does not count. */
export async function undoRenderJobDispatch(lease: RenderJobLease): Promise<void> {
  const { pool } = await renderQueuePersistence();
  await pool.query(
    `UPDATE render_jobs
        SET attempt = greatest(attempt - 1, 0), lease_worker_id = NULL, lease_heartbeat_at = NULL
      WHERE ${HELD} AND status = 'queued'`,
    leaseParams(lease),
  );
}

/** The render service accepted the queued job under `renderJobId`. */
export async function markRenderJobDispatched(
  lease: RenderJobLease,
  target: string,
  renderJobId: string,
): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs
        SET status = 'dispatched', render_target = $4, render_job_id = $5,
            progress = 0, stage = NULL, updated_at = now()
      WHERE ${HELD} AND status = 'queued'`,
    [...leaseParams(lease), target, renderJobId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Give the job up without changing what it waits for (the render service had
 * no room, or this process is stopping): the next claim picks it up.
 */
export async function releaseRenderJob(lease: RenderJobLease): Promise<void> {
  const { pool } = await renderQueuePersistence();
  await pool.query(
    `UPDATE render_jobs SET lease_worker_id = NULL, lease_heartbeat_at = NULL WHERE ${HELD}`,
    leaseParams(lease),
  );
}

/** The render service lost the job: back to the queue, to be sent again from the start. */
export async function requeueRenderJob(lease: RenderJobLease): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs
        SET status = 'queued', render_target = NULL, render_job_id = NULL, progress = 0,
            stage = NULL, lease_worker_id = NULL, lease_heartbeat_at = NULL, updated_at = now()
      WHERE ${HELD} AND status = ANY($4::text[])`,
    [...leaseParams(lease), AT_RENDER],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The job failed; it stays readable (with why) until the sweep removes it. */
export async function failRenderJob(
  lease: RenderJobLease,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs
        SET status = 'failed', error_code = $4, error_message = $5, finished_at = now(),
            lease_worker_id = NULL, lease_heartbeat_at = NULL, updated_at = now()
      WHERE ${HELD} AND status = ANY($6::text[])`,
    [...leaseParams(lease), errorCode, errorMessage, ['queued', ...AT_RENDER]],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The output parts recorded so far, or null once the lease or job is gone. */
export async function readRenderJobOutputParts(
  lease: RenderJobLease,
): Promise<RenderJobPart[] | null> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query<{ output_parts: RenderJobPart[] }>(
    `SELECT output_parts FROM render_jobs WHERE ${HELD} AND status = ANY($4::text[])`,
    [...leaseParams(lease), AT_RENDER],
  );
  return result.rows[0]?.output_parts ?? null;
}

/**
 * Forget the output parts an earlier copy left (it was interrupted, or the
 * job was sent again); the caller has deleted their bytes. False once the
 * lease or job is gone.
 */
export async function resetRenderJobOutput(lease: RenderJobLease): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs SET output_parts = '[]'::jsonb, output_bytes = 0, updated_at = now()
      WHERE ${HELD} AND status = ANY($4::text[])`,
    [...leaseParams(lease), AT_RENDER],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The cancelled job is cancelled at the render service too: nothing is left to do. */
export async function finishRenderJobCancel(lease: RenderJobLease): Promise<void> {
  const { pool } = await renderQueuePersistence();
  await pool.query(
    `UPDATE render_jobs
        SET render_job_id = NULL, lease_worker_id = NULL, lease_heartbeat_at = NULL
      WHERE ${HELD} AND status = 'cancelled'`,
    leaseParams(lease),
  );
}

/** Record an output part before its bytes are written; false once the lease or job is gone. */
export async function recordRenderOutputPart(
  lease: RenderJobLease,
  part: RenderJobPart,
  totalBytes: number,
): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs
        SET output_parts = output_parts || $4::jsonb, output_bytes = $5,
            lease_heartbeat_at = $6, updated_at = now()
      WHERE ${HELD} AND status = ANY($7::text[])`,
    [...leaseParams(lease), JSON.stringify([part]), totalBytes, Date.now(), AT_RENDER],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Every output part is stored: the MP4 is downloadable. */
export async function succeedRenderJob(lease: RenderJobLease): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const result = await pool.query(
    `UPDATE render_jobs
        SET status = 'succeeded', progress = 1, finished_at = now(),
            lease_worker_id = NULL, lease_heartbeat_at = NULL, updated_at = now()
      WHERE ${HELD} AND status = ANY($4::text[])`,
    [...leaseParams(lease), AT_RENDER],
  );
  return (result.rowCount ?? 0) > 0;
}

/** A job's stored parts the sweep has taken over: nothing records or reads them any more. */
export interface TakenRenderParts {
  id: string;
  input: RenderJobPart[];
  output: RenderJobPart[];
}

/**
 * End the uploads that stopped writing `staleUploadMs` ago: they fail, so an
 * upload that resumes can record no more parts, and their parts are taken
 * with the other finished jobs' inputs.
 */
export async function abandonStaleRenderUploads(
  tx: Queryable,
  staleUploadMs: number,
): Promise<void> {
  await tx.query(
    `UPDATE render_jobs
        SET status = 'failed', error_code = 'upload_abandoned',
            error_message = 'The upload did not complete', finished_at = now(), updated_at = now()
      WHERE status = 'uploading'
        AND updated_at < now() - make_interval(secs => $1::double precision / 1000)`,
    [staleUploadMs],
  );
}

/**
 * Take the input parts of finished jobs: the row forgets them in the same
 * statement that returns them, so only the caller deletes their bytes, and a
 * late upload write finds its part no longer listed.
 */
export async function takeFinishedRenderInputs(
  tx: Queryable,
  limit = 50,
): Promise<TakenRenderParts[]> {
  const result = await tx.query<{ id: string; input_parts: RenderJobPart[] }>(
    `WITH taken AS (
       SELECT id, input_parts FROM render_jobs
        WHERE finished_at IS NOT NULL AND input_parts <> '[]'::jsonb
        ORDER BY finished_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE render_jobs r SET input_parts = '[]'::jsonb FROM taken
      WHERE r.id = taken.id
     RETURNING taken.id, taken.input_parts`,
    [limit],
  );
  return result.rows.map((row) => ({ id: row.id, input: row.input_parts, output: [] }));
}

/**
 * Take the jobs finished `retentionMs` ago: their rows are deleted in the
 * statement that returns their parts.
 */
export async function takeExpiredRenderJobs(
  tx: Queryable,
  retentionMs: number,
  limit = 50,
): Promise<TakenRenderParts[]> {
  const result = await tx.query<{
    id: string;
    input_parts: RenderJobPart[];
    output_parts: RenderJobPart[];
  }>(
    `WITH taken AS (
       SELECT id FROM render_jobs
        WHERE finished_at < now() - make_interval(secs => $1::double precision / 1000)
        ORDER BY finished_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     DELETE FROM render_jobs r USING taken WHERE r.id = taken.id
     RETURNING r.id, r.input_parts, r.output_parts`,
    [retentionMs, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    input: row.input_parts,
    output: row.output_parts,
  }));
}

/**
 * Whether a part just written is still listed on its job. Read under the
 * row's share lock, so it waits for a sweep that is taking the parts: a part
 * no longer listed was taken (or its job deleted), and its writer deletes the
 * bytes it wrote after the sweep's own delete.
 */
export async function isRenderPartListed(
  jobId: string,
  kind: 'input' | 'output',
  part: RenderJobPart,
): Promise<boolean> {
  const { pool } = await renderQueuePersistence();
  const column = kind === 'input' ? 'input_parts' : 'output_parts';
  const result = await pool.query<{ listed: boolean }>(
    `SELECT ${column} @> $2::jsonb AS listed FROM render_jobs WHERE id = $1 FOR SHARE`,
    [jobId, JSON.stringify([{ hash: part.hash }])],
  );
  return result.rows[0]?.listed === true;
}

export type { Queryable };
