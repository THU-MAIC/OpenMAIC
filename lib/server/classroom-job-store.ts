import { createHash, randomUUID } from 'crypto';
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
  /** Private lifecycle metadata; the GET API does not expose it. */
  sourceDigest?: string;
  executionOwner?: {
    instanceId: string;
    pid: number;
    processStartTicks?: string;
  };
}

function jobFilePath(jobId: string) {
  return path.join(CLASSROOM_JOBS_DIR, `${jobId}.json`);
}

function buildInputSummary(input: GenerateClassroomInput): ClassroomGenerationJob['inputSummary'] {
  return {
    requirementPreview:
      input.requirement.length > 200 ? `${input.requirement.slice(0, 197)}...` : input.requirement,
    hasPdf: !!input.pdfContent,
    pdfTextLength: input.pdfContent?.text.length || 0,
    pdfImageCount: input.pdfContent?.images.length || 0,
  };
}

interface ClassroomJobRuntime {
  instanceId: string;
  owner: Promise<NonNullable<ClassroomGenerationJob['executionOwner']>>;
  locks: Map<string, Promise<void>>;
  activeJobs: Set<string>;
  runners: Map<string, Promise<void>>;
}

function processStartTicks(stat: string): string | undefined {
  // Linux comm may contain spaces/parentheses; fields after its final ')' start at field 3.
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const tail = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  return /^\d+$/.test(tail[19] || '') ? tail[19] : undefined;
}

const shared = globalThis as typeof globalThis & {
  __openmaicClassroomJobRuntimeV1?: ClassroomJobRuntime;
};
const runtime = (shared.__openmaicClassroomJobRuntimeV1 ??= (() => {
  const instanceId = randomUUID();
  const owner = (async () => {
    let ticks: string | undefined;
    if (process.platform === 'linux') {
      try {
        ticks = processStartTicks(await fs.readFile('/proc/self/stat', 'utf-8'));
      } catch {
        /* Optional portable process fingerprint. */
      }
    }
    return { instanceId, pid: process.pid, ...(ticks ? { processStartTicks: ticks } : {}) };
  })();
  return { instanceId, owner, locks: new Map(), activeJobs: new Set(), runners: new Map() };
})());

/** Shared even when Next compiles the route and runner into separate bundles. */
export function getClassroomGenerationJobRunnerMap(): Map<string, Promise<void>> {
  return runtime.runners;
}

export function releaseClassroomGenerationJobRunner(jobId: string): void {
  runtime.activeJobs.delete(jobId);
}

/** Digest includes exact source strings and all nested generation options, never their raw text. */
function inputDigest(input: GenerateClassroomInput): string {
  const serialized = JSON.stringify(input, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value,
  );
  if (typeof serialized !== 'string') throw new Error('Invalid classroom generation input');
  return createHash('sha256').update(serialized).digest('hex');
}

/** Per-job mutex serializes local read/modify/write and terminal transitions. */
async function withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const prev = runtime.locks.get(jobId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  runtime.locks.set(jobId, next);
  try {
    await prev;
    return await fn();
  } finally {
    resolve!();
    if (runtime.locks.get(jobId) === next) runtime.locks.delete(jobId);
  }
}

const QUEUED_START_GRACE_MS = 2 * 60 * 1000;
// Generation has its own 12 minute abort budget; this is only an orphan-status ceiling.
const ORPHAN_JOB_MAX_AGE_MS = 14 * 60 * 1000;

function ownedHere(job: ClassroomGenerationJob): boolean {
  return (
    job.executionOwner?.instanceId === runtime.instanceId && job.executionOwner.pid === process.pid
  );
}

async function ownerLiveness(
  job: ClassroomGenerationJob,
): Promise<'current' | 'alive' | 'dead' | 'unknown'> {
  if (ownedHere(job)) return 'current';
  const owner = job.executionOwner;
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'unknown';
  if (process.platform === 'linux' && owner.processStartTicks) {
    try {
      const currentTicks = processStartTicks(await fs.readFile(`/proc/${owner.pid}/stat`, 'utf-8'));
      return currentTicks
        ? currentTicks === owner.processStartTicks
          ? 'alive'
          : 'dead'
        : 'unknown';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown';
    }
  }
  try {
    process.kill(owner.pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

/** Derive a failed poll view without racing another process's terminal disk write. */
async function markOrphanedIfNeeded(job: ClassroomGenerationJob): Promise<ClassroomGenerationJob> {
  if (job.status === 'succeeded' || job.status === 'failed') return job;
  const liveness = await ownerLiveness(job);
  const createdAt = new Date(job.createdAt).getTime();
  const startedAt = new Date(job.startedAt || job.createdAt).getTime();
  const age = Date.now() - (job.status === 'queued' ? createdAt : startedAt);
  let error: string | undefined;
  if (liveness === 'dead')
    error = 'Generation was interrupted by a server restart; retry manually from AIOJ';
  else if (
    job.status === 'queued' &&
    (!Number.isFinite(age) || age < -60_000 || age > QUEUED_START_GRACE_MS)
  )
    error = 'Generation did not start within its queue window; retry manually from AIOJ';
  else if (job.status === 'running' && liveness === 'current' && !runtime.activeJobs.has(job.id))
    error = 'Generation no longer has an active runner; retry manually from AIOJ';
  else if (
    job.status === 'running' &&
    (!Number.isFinite(age) || age < -60_000 || age > ORPHAN_JOB_MAX_AGE_MS)
  )
    error = 'Generation exceeded its recovery window; retry manually from AIOJ';
  if (!error) return job;
  const now = new Date().toISOString();
  return {
    ...job,
    status: 'failed',
    step: 'failed',
    message: 'Classroom generation interrupted',
    error,
    completedAt: now,
    updatedAt: now,
  };
}

async function readJobFile(jobId: string): Promise<ClassroomGenerationJob | null> {
  if (!isValidClassroomJobId(jobId)) throw new Error('Invalid classroom generation job id');
  try {
    const content = await fs.readFile(jobFilePath(jobId), 'utf-8');
    return JSON.parse(content) as ClassroomGenerationJob;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function isValidClassroomJobId(jobId: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(jobId);
}

export async function createClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
): Promise<ClassroomGenerationJob> {
  // Capture before any await; mutation by the caller cannot change the queued source.
  const snapshot = structuredClone(input);
  const sourceDigest = inputDigest(snapshot);
  const inputSummary = buildInputSummary(snapshot);
  return withJobLock(jobId, async () => {
    if (await readJobFile(jobId)) throw new Error('Classroom generation job already exists');
    const now = new Date().toISOString();
    const job: ClassroomGenerationJob = {
      id: jobId,
      status: 'queued',
      step: 'queued',
      progress: 0,
      message: 'Classroom generation job queued',
      createdAt: now,
      updatedAt: now,
      inputSummary,
      sourceDigest,
      executionOwner: await runtime.owner,
      scenesGenerated: 0,
    };
    await ensureClassroomJobsDir();
    await writeJsonFileAtomic(jobFilePath(jobId), job);
    return job;
  });
}

export async function readClassroomGenerationJob(
  jobId: string,
): Promise<ClassroomGenerationJob | null> {
  return withJobLock(jobId, async () => {
    const job = await readJobFile(jobId);
    return job ? markOrphanedIfNeeded(job) : null;
  });
}

const EDITABLE_JOB_FIELDS = [
  'status',
  'step',
  'progress',
  'message',
  'scenesGenerated',
  'totalScenes',
  'result',
  'error',
  'completedAt',
] as const;

export async function updateClassroomGenerationJob(
  jobId: string,
  patch: Partial<ClassroomGenerationJob>,
): Promise<ClassroomGenerationJob> {
  return withJobLock(jobId, async () => {
    const stored = await readJobFile(jobId);
    if (!stored) throw new Error('Classroom generation job not found');
    const existing = await markOrphanedIfNeeded(stored);
    // No late progress/result/failure may resurrect or alter any terminal record.
    if (existing.status === 'succeeded' || existing.status === 'failed' || !ownedHere(existing))
      return existing;
    if (existing.status === 'queued' && patch.status !== 'failed') return existing;
    if (
      existing.status === 'running' &&
      patch.status &&
      !['running', 'succeeded', 'failed'].includes(patch.status)
    )
      return existing;
    const editable = Object.fromEntries(
      EDITABLE_JOB_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(patch, key)).map(
        (key) => [key, patch[key]],
      ),
    ) as Partial<ClassroomGenerationJob>;
    if (!Object.keys(editable).length) return existing;
    const updated = { ...existing, ...editable, updatedAt: new Date().toISOString() };
    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    return updated;
  });
}

/** Exactly one source-bound queued job from this instance may start paid work. */
export async function markClassroomGenerationJobRunning(
  jobId: string,
  input: GenerateClassroomInput,
): Promise<ClassroomGenerationJob | null> {
  const sourceDigest = inputDigest(input);
  return withJobLock(jobId, async () => {
    const stored = await readJobFile(jobId);
    if (!stored) return null;
    const existing = await markOrphanedIfNeeded(stored);
    if (existing.status !== 'queued' || !ownedHere(existing)) return null;
    if (existing.sourceDigest !== sourceDigest)
      throw new Error('Classroom generation input does not match the queued source');
    const now = new Date().toISOString();
    const updated: ClassroomGenerationJob = {
      ...existing,
      status: 'running',
      startedAt: now,
      message: 'Classroom generation started',
      updatedAt: now,
    };
    await writeJsonFileAtomic(jobFilePath(jobId), updated);
    runtime.activeJobs.add(jobId);
    return updated;
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
  return updateClassroomGenerationJob(jobId, {
    status: 'failed',
    step: 'failed',
    message: 'Classroom generation failed',
    completedAt: new Date().toISOString(),
    error,
  });
}
