import { promises as fs } from 'fs';
import path from 'path';
import type {
  ClassroomGenerationProgress,
  ClassroomGenerationStep,
  GenerateClassroomInput,
  GenerateClassroomResult,
} from '@/lib/server/classroom-generation';
import {
  CLASSROOM_JOBS_DIR,
  ensureClassroomJobsDir,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';
import { readJsonBlob, writeJsonBlob, USE_BLOB } from '@/lib/server/blob-store';
import { USE_NEON, neonSelect, neonExec } from '@/lib/server/neon-store';

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
    language: string;
    hasPdf: boolean;
    pdfTextLength: number;
    pdfImageCount: number;
  };
  scenesGenerated: number;
  totalScenes?: number;
  result?: {
    classroomId: string;
    url: string;
    scenesCount: number;
  };
  error?: string;
  /** The pipeline step that was active when the job failed. */
  failedAtStep?: ClassroomGenerationStep;
  /** Wall-clock milliseconds from startedAt to completedAt. */
  durationMs?: number;
}

function jobBlobKey(jobId: string) {
  return `classroom-jobs/${jobId}.json`;
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    language: input.language || 'en-US',
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
  };
}

/**
 * In-process job cache.
 * Within the runner's serverless invocation, reads are served from this cache
 * instead of calling list() on Vercel Blob for every progress read-modify-write.
 * The poller (a separate invocation) always falls through to blob on cache miss.
 */
const jobCache = new Map<string, ClassroomGenerationJob>();

/**
 * Minimum interval between intermediate progress blob writes.
 * Lifecycle transitions (create/running/succeeded/failed) always bypass this.
 */
const PROGRESS_WRITE_THROTTLE_MS = 8_000;
const lastProgressWriteAt = new Map<string, number>();

/** Simple per-job mutex to serialize read-modify-write on the same job file. */
const jobLocks = new Map<string, Promise<void>>();

async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  jobLocks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (jobLocks.get(jobId) === next) jobLocks.delete(jobId);
  }
}

/** Max age (ms) before a "running" job without an active runner is considered stale. */
const STALE_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function markStaleIfNeeded(job: ClassroomGenerationJob): ClassroomGenerationJob {
  if (job.status !== 'running') return job;
  const updatedAt = new Date(job.updatedAt).getTime();
  if (Date.now() - updatedAt > STALE_JOB_TIMEOUT_MS) {
    const completedAt = new Date().toISOString();
    const activeStep =
      job.step !== 'queued' && job.step !== 'failed'
        ? (job.step as ClassroomGenerationStep)
        : undefined;
    const durationMs = job.startedAt
      ? new Date(completedAt).getTime() - new Date(job.startedAt).getTime()
      : undefined;
    return {
      ...job,
      status: 'failed',
      step: 'failed',
      message: `Job appears stale during "${activeStep ?? job.step}" (no progress update for 30 minutes)`,
      error: 'Stale job: process may have restarted during generation',
      completedAt,
      updatedAt: completedAt,
      failedAtStep: activeStep,
      durationMs,
    };
  }
  return job;
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

/** Write a job record to the configured store and update the in-process cache. */
async function writeJob(jobId: string, job: ClassroomGenerationJob): Promise<void> {
  jobCache.set(jobId, job);
  if (USE_NEON) {
    await neonExec(
      `INSERT INTO classroom_jobs (id, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2::jsonb, updated_at = NOW()`,
      [jobId, JSON.stringify(job)],
    );
  } else if (USE_BLOB) {
    await writeJsonBlob(jobBlobKey(jobId), job);
  } else {
    await writeJsonFileAtomic(jobFilePath(jobId), job);
  }
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
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

  if (!USE_BLOB) await ensureClassroomJobsDir();
  await writeJob(jobId, job);
  return job;
}

export async function readClassroomGenerationJob(
  jobId: string,
): Promise<ClassroomGenerationJob | null> {
  const cached = jobCache.get(jobId);
  if (cached) return markStaleIfNeeded(cached);

  if (USE_NEON) {
    const rows = await neonSelect<{ data: ClassroomGenerationJob }>(
      'SELECT data FROM classroom_jobs WHERE id = $1',
      [jobId],
    );
    const job = rows[0]?.data ?? null;
    if (job) jobCache.set(jobId, job);
    return job ? markStaleIfNeeded(job) : null;
  }

  if (USE_BLOB) {
    const job = await readJsonBlob<ClassroomGenerationJob>(jobBlobKey(jobId));
    if (job) jobCache.set(jobId, job);
    return job ? markStaleIfNeeded(job) : null;
  }

  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    const job = JSON.parse(content) as ClassroomGenerationJob;
    jobCache.set(jobId, job);
    return markStaleIfNeeded(job);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };

    await writeJob(jobId, updated);
    return updated;
  });
}

export async function markClassroomGenerationJobRunning(
  jobId: string,
  /** When provided, skip the blob read — avoids eventual-consistency misses
   *  that occur when the runner starts immediately after job creation. */
  knownJob?: ClassroomGenerationJob,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = knownJob ?? await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      startedAt: existing.startedAt || new Date().toISOString(),
      message: 'Classroom generation started',
      updatedAt: new Date().toISOString(),
    };

    await writeJob(jobId, updated);
    return updated;
  });
}

export async function updateClassroomGenerationJobProgress(
  jobId: string,
  progress: ClassroomGenerationProgress,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const existing = jobCache.get(jobId) ?? await readClassroomGenerationJob(jobId);
    if (!existing) throw new Error(`Classroom generation job not found: ${jobId}`);

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      step: progress.step,
      progress: progress.progress,
      message: progress.message,
      scenesGenerated: progress.scenesGenerated,
      totalScenes: progress.totalScenes,
      updatedAt: new Date().toISOString(),
    };

    // Always update in-process cache so the runner sees the latest state.
    jobCache.set(jobId, updated);

    // Throttle blob writes: intermediate progress is visible to the poller on
    // the next write interval. Lifecycle transitions bypass this throttle.
    const now = Date.now();
    if (now - (lastProgressWriteAt.get(jobId) ?? 0) >= PROGRESS_WRITE_THROTTLE_MS) {
      lastProgressWriteAt.set(jobId, now);
      if (USE_BLOB) {
        await writeJsonBlob(jobBlobKey(jobId), updated);
      } else {
        await writeJsonFileAtomic(jobFilePath(jobId), updated);
      }
    }

    return updated;
  });
}

export async function markClassroomGenerationJobSucceeded(
  jobId: string,
  result: GenerateClassroomResult,
): Promise<ClassroomGenerationJob> {
  lastProgressWriteAt.delete(jobId);
  return updateClassroomGenerationJob(jobId, {
    status: 'succeeded',
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    completedAt: new Date().toISOString(),
    scenesGenerated: result.scenesCount,
    result: {
      classroomId: result.id,
      url: result.url,
      scenesCount: result.scenesCount,
    },
  });
}

export async function markClassroomGenerationJobFailed(
  jobId: string,
  error: string,
): Promise<ClassroomGenerationJob> {
  lastProgressWriteAt.delete(jobId);
  return withJobLock(jobId, async () => {
    const existing = await readClassroomGenerationJob(jobId);
    if (!existing) {
      throw new Error(`Classroom generation job not found: ${jobId}`);
    }

    const completedAt = new Date().toISOString();
    const durationMs = existing.startedAt
      ? new Date(completedAt).getTime() - new Date(existing.startedAt).getTime()
      : undefined;

    // Preserve the pipeline step that was active when the failure occurred.
    const activeStep =
      existing.step !== 'queued' && existing.step !== 'failed'
        ? (existing.step as ClassroomGenerationStep)
        : undefined;

    const stepLabel = activeStep ?? existing.step;
    const sceneContext =
      existing.totalScenes != null
        ? ` (scene ${existing.scenesGenerated}/${existing.totalScenes})`
        : '';

    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'failed',
      step: 'failed',
      message: `Classroom generation failed during "${stepLabel}"${sceneContext}`,
      completedAt,
      updatedAt: completedAt,
      error,
      failedAtStep: activeStep,
      durationMs,
    };

    await writeJob(jobId, updated);
    return updated;
  });
}
