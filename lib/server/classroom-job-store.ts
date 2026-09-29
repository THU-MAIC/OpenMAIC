import type {
  ClassroomGenerationProgress,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import type { Queryable } from '@openmaic/storage/document/pg';

import { canonicalizeOwner } from '@/lib/persistence/owner-merges';
import { getServerPersistenceProvider } from '@/lib/persistence/server-provider';

export type ClassroomGenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ClassroomGenerationJob {
  id: string;
  status: ClassroomGenerationJobStatus;
  step: ClassroomGenerationStep | 'queued' | 'failed';
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  inputSummary: {
    requirementPreview: string;
    materialCount: number;
  };
  scenesGenerated: number;
  totalScenes?: number;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
    ttsCoverage?: GenerateClassroomResult['ttsCoverage'];
    warning?: string;
  };
  error?: string;
}

/**
 * Jobs live in PostgreSQL (`classroom_generation_jobs`, see
 * `lib/persistence/classroom-generation-jobs.ts`), beside the course they
 * produce, so a job can be polled from any instance and survives a restart as
 * a record (a restarted process does not resume the run; the stale check below
 * reports it as failed).
 */
async function jobsPool() {
  const { pool } = await getServerPersistenceProvider(process.env.DATABASE_URL ?? '');
  return pool;
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    materialCount: input.materialIds?.length ?? 0,
  };
}

/** Max age (ms) before a "running" job without an active runner is considered stale. */
const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function markStaleIfNeeded(job: ClassroomGenerationJob): ClassroomGenerationJob {
  if (job.status !== 'running') return job;
  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    return {
      ...job,
      status: 'failed',
      step: 'failed',
      message: 'Job appears stale (no progress update for 30 minutes)',
      error: 'Stale job: process may have restarted during generation',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return job;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  { ownerId }: { ownerId: string },
): Promise<ClassroomGenerationJob> {
  const now = new Date().toISOString();
  const job: ClassroomGenerationJob = {
    id: jobId,
    status: 'queued',
    step: 'queued',
    progress: 0,
    message: 'Classroom generation job queued',
    createdAt: now,
    updatedAt: now,
    inputSummary: buildInputSummary(input),
    scenesGenerated: 0,
  };

  const pool = await jobsPool();
  await pool.query(
    'INSERT INTO classroom_generation_jobs (id, owner_id, record) VALUES ($1, $2, $3::jsonb)',
    [jobId, ownerId, JSON.stringify(job)],
  );
  return job;
}

/**
 * The job, for the owner asking about it. A job another owner created answers
 * `null`, exactly like an unknown id, so a job id is not an existence oracle.
 * The owner a job was created for may since have been claimed into an account
 * (a visitor who signed in while the course generated); that account sees the
 * job too, as it sees the course.
 */
export async function readClassroomGenerationJob(
  jobId: string,
  ownerId: string,
): Promise<ClassroomGenerationJob | null> {
  const pool = await jobsPool();
  const result = await pool.query<{ owner_id: string; record: ClassroomGenerationJob }>(
    'SELECT owner_id, record FROM classroom_generation_jobs WHERE id = $1',
    [jobId],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (
    row.owner_id !== ownerId &&
    (await canonicalizeOwner(pool as unknown as Queryable, row.owner_id)) !== ownerId
  ) {
    return null;
  }
  return markStaleIfNeeded(row.record);
}

/**
 * Merge `patch` into the job record in one statement, so concurrent progress
 * writes of one job never lose each other's fields. `startedAt` is kept once
 * set: the last operand re-applies the stored value over the patch.
 */
async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
): Promise<ClassroomGenerationJob> {
  const pool = await jobsPool();
  const result = await pool.query<{ record: ClassroomGenerationJob }>(
    `UPDATE classroom_generation_jobs
        SET record = record || $2::jsonb
                     || jsonb_strip_nulls(jsonb_build_object('startedAt', record->'startedAt')),
            updated_at = now()
      WHERE id = $1
      RETURNING record`,
    [jobId, JSON.stringify({ ...patch, updatedAt: new Date().toISOString() })],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Classroom generation job not found: ${jobId}`);
  }
  return row.record;
}

export async function markClassroomGenerationJobRunning(
  jobId: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'running',
    startedAt: new Date().toISOString(),
    message: 'Classroom generation started',
  });
}

export async function updateClassroomGenerationJobProgress(
  jobId: string,
  progress: ClassroomGenerationProgress,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'running',
    step: progress.step,
    progress: progress.progress,
    message: progress.message,
    scenesGenerated: progress.scenesGenerated,
    totalScenes: progress.totalScenes,
  });
}

export async function markClassroomGenerationJobSucceeded(
  jobId: string,
  result: GenerateClassroomResult,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'succeeded',
    step: 'completed',
    progress: 100,
    message: result.warning ?? 'Classroom generation completed',
    completedAt: new Date().toISOString(),
    scenesGenerated: result.scenesCount,
    result: {
      classroomId: result.id,
      url: result.url,
      scenesCount: result.scenesCount,
      ...(result.ttsCoverage ? { ttsCoverage: result.ttsCoverage } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    },
  });
}

export async function markClassroomGenerationJobFailed(
  jobId: string,
  error: string,
): Promise<ClassroomGenerationJob> {
  return updateClassroomGenerationJob(jobId, {
    status: 'failed',
    step: 'failed',
    message: 'Classroom generation failed',
    completedAt: new Date().toISOString(),
    error,
  });
}
