/**
 * RenderCoordinator — owns admission, queueing, job state, artifacts, and
 * cleanup while delegating rendering policy to the RenderExecutor seam.
 *
 * Admission is split from enqueue so a caller is bounded before archive
 * extraction: reserve(identity) atomically claims a slot, submit() consumes it,
 * and release() undoes it when extraction fails.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ArtifactStore } from './artifact-store.js';
import { config } from './config.js';
import type { JobStore } from './job-store.js';
import type { RenderExecutor } from './render-executor.js';
import { Semaphore } from './semaphore.js';
import type {
  RenderCancelledFailure,
  RenderExecutionResult,
  RenderFailedFailure,
  RenderJobRecord,
  RenderOptions,
} from './types.js';

/** Thrown when admission control rejects a submission (mapped to HTTP 429). */
export class RenderRejectedError extends Error {}

function planPathForProject(dir: string): string {
  return join(
    dirname(dir),
    `.render-plan-${createHash('sha256').update(dir).digest('hex').slice(0, 12)}`,
  );
}

/** An accepted admission slot, returned by RenderCoordinator.reserve. */
export interface Reservation {
  identity: string;
  consumed: boolean;
}

interface QueuedJob {
  record: RenderJobRecord;
  options: RenderOptions;
  abort: AbortController;
}

export interface RenderCoordinatorOptions {
  maxConcurrency?: number;
  maxQueue?: number;
  maxJobsPerUser?: number;
  jobDeadlineMs?: number;
}

export class RenderCoordinator {
  private running = 0;
  private readonly queue: QueuedJob[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly activeByIdentity = new Map<string, number>();
  private pending = 0;
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  private readonly maxJobsPerUser: number;
  private readonly jobDeadlineMs: number;
  private readonly executionGate: Semaphore;

  constructor(
    private readonly executor: RenderExecutor,
    private readonly jobs: JobStore,
    private readonly artifacts: ArtifactStore,
    options: RenderCoordinatorOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency ?? config.maxConcurrency;
    this.maxQueue = options.maxQueue ?? config.maxQueue;
    this.maxJobsPerUser = options.maxJobsPerUser ?? config.maxJobsPerUser;
    this.jobDeadlineMs = options.jobDeadlineMs ?? config.jobDeadlineMs;
    this.executionGate = new Semaphore(this.maxConcurrency);
  }

  /** Run Chromium-backed work within the service-wide execution budget. */
  runWithExecutionSlot<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.executionGate.run(task, signal);
  }

  /** Total jobs occupying the system: reserved + queued + running. */
  private get inSystem(): number {
    return this.pending + this.queue.length + this.running;
  }

  /** Claim an admission slot before buffering or extracting the archive. */
  reserve(identity: string): Reservation {
    if (this.inSystem >= this.maxQueue) {
      throw new RenderRejectedError('The render queue is full; try again shortly.');
    }
    if (this.maxJobsPerUser > 0) {
      const active = this.activeByIdentity.get(identity) ?? 0;
      if (active >= this.maxJobsPerUser) {
        throw new RenderRejectedError(
          `A render is already in progress (limit ${this.maxJobsPerUser}).`,
        );
      }
    }
    this.activeByIdentity.set(identity, (this.activeByIdentity.get(identity) ?? 0) + 1);
    this.pending += 1;
    return { identity, consumed: false };
  }

  /** Release a reservation that will not become a job. */
  release(reservation: Reservation): void {
    if (reservation.consumed) return;
    reservation.consumed = true;
    this.pending = Math.max(0, this.pending - 1);
    this.decrementIdentity(reservation.identity);
  }

  private decrementIdentity(identity: string): void {
    const next = (this.activeByIdentity.get(identity) ?? 0) - 1;
    if (next <= 0) this.activeByIdentity.delete(identity);
    else this.activeByIdentity.set(identity, next);
  }

  /** Enqueue a render against a held reservation and return its stable job id. */
  async submit(
    reservation: Reservation,
    projectDir: string,
    options: RenderOptions,
  ): Promise<string> {
    if (reservation.consumed) throw new RenderRejectedError('Reservation already used');

    reservation.consumed = true;
    this.pending = Math.max(0, this.pending - 1);

    const id = randomUUID();
    const now = Date.now();
    const record: RenderJobRecord = {
      id,
      userId: reservation.identity,
      status: 'queued',
      progress: 0,
      currentStage: 'queued',
      createdAtMs: now,
      updatedAtMs: now,
      projectDir,
    };
    try {
      await this.jobs.create(record);
    } catch (error) {
      this.decrementIdentity(reservation.identity);
      throw error;
    }

    const abort = new AbortController();
    this.controllers.set(id, abort);
    this.queue.push({ record, options, abort });
    this.pump();
    return id;
  }

  /** Cancel a queued or running job through the same AbortSignal executor seam. */
  async cancel(id: string): Promise<boolean> {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();

    const queuedIdx = this.queue.findIndex((queued) => queued.record.id === id);
    if (queuedIdx >= 0) {
      const [queued] = this.queue.splice(queuedIdx, 1);
      this.controllers.delete(id);
      if (queued.record.userId) this.decrementIdentity(queued.record.userId);
      const failure: RenderCancelledFailure = {
        code: 'cancelled',
        message: 'Render cancelled',
      };
      await this.jobs.update(id, {
        status: 'cancelled',
        currentStage: 'cancelled',
        failure,
      });
      await this.cleanupProject(queued.record.projectDir);
    }
    return true;
  }

  private pump(): void {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running += 1;
      void this.run(next);
    }
  }

  private async finishNonSuccess(
    id: string,
    projectDir: string,
    result: Exclude<RenderExecutionResult, { status: 'succeeded' }>,
  ): Promise<void> {
    try {
      await this.jobs.update(id, {
        status: result.status,
        currentStage: result.status,
        failure: result.failure,
        error: result.failure.message,
        ...(result.performance ? { performance: result.performance } : {}),
        ...(result.metrics ? { metrics: result.metrics } : {}),
      });
    } finally {
      await this.cleanupProject(projectDir);
    }
  }

  private async run({ record, options, abort }: QueuedJob): Promise<void> {
    const { id, projectDir } = record;
    const outputPath = join(projectDir, 'output.mp4');
    try {
      await this.jobs.update(id, { status: 'running', currentStage: 'preparing' });
      const result = await this.runWithExecutionSlot(
        () =>
          this.executor.execute({
            projectDir,
            outputPath,
            options,
            signal: abort.signal,
            deadlineMs: this.jobDeadlineMs,
            onProgress: async (progress) => {
              await this.jobs.update(id, {
                status: 'running',
                progress: progress.progress,
                currentStage: progress.stage,
                ...(progress.framesRendered !== undefined
                  ? { framesRendered: progress.framesRendered }
                  : {}),
                ...(progress.totalFrames !== undefined
                  ? { totalFrames: progress.totalFrames }
                  : {}),
              });
            },
          }),
        abort.signal,
      );

      if (result.status !== 'succeeded') {
        await this.finishNonSuccess(id, projectDir, result);
        return;
      }

      if (abort.signal.aborted) {
        await this.finishNonSuccess(id, projectDir, {
          status: 'cancelled',
          failure: { code: 'cancelled', message: 'Render cancelled' },
          ...(result.performance ? { performance: result.performance } : {}),
          ...(result.metrics ? { metrics: result.metrics } : {}),
        });
        return;
      }

      await this.artifacts.put(id, outputPath);
      await this.jobs.update(id, {
        status: 'succeeded',
        progress: 1,
        currentStage: 'complete',
        outputPath,
        ...(result.performance ? { performance: result.performance } : {}),
        ...(result.metrics ? { metrics: result.metrics } : {}),
      });
    } catch (error) {
      await this.artifacts.remove(id).catch(() => {});
      if (abort.signal.aborted) {
        await this.finishNonSuccess(id, projectDir, {
          status: 'cancelled',
          failure: { code: 'cancelled', message: 'Render cancelled' },
        });
        return;
      }
      const failure: RenderFailedFailure = {
        code: 'execution_failed',
        message: error instanceof Error ? error.message : String(error),
      };
      await this.finishNonSuccess(id, projectDir, { status: 'failed', failure });
    } finally {
      this.controllers.delete(id);
      if (record.userId) this.decrementIdentity(record.userId);
      this.running -= 1;
      this.pump();
    }
  }

  /** Best-effort recursive delete of a job's unzipped project dir. */
  async cleanupProject(dir: string): Promise<void> {
    await Promise.all([
      rm(dir, { recursive: true, force: true }).catch(() => {}),
      rm(planPathForProject(dir), { recursive: true, force: true }).catch(() => {}),
      rm(`${planPathForProject(dir)}.local.json`, { force: true }).catch(() => {}),
      rm(`${planPathForProject(dir)}.chunks`, { recursive: true, force: true }).catch(() => {}),
    ]);
  }
}

/** Create a fresh per-render project directory under the configured tmp root. */
export async function makeProjectDir(): Promise<string> {
  return mkdtemp(join(config.tmpDir, 'render-'));
}
