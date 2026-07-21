/**
 * RenderManager — owns a render job's whole lifecycle: admission (concurrency,
 * per-identity, and global-queue guards), the FIFO queue, driving
 * `@hyperframes/producer`, feeding progress into the JobStore, registering the
 * artifact, a per-job wall-clock deadline, and cleanup.
 *
 * Admission is split from enqueue so a caller is bounded *before* the expensive
 * archive extraction: `reserve(identity)` atomically claims a slot (or throws),
 * the route extracts, then `submit()` consumes the reservation. `release()`
 * undoes a reservation if extraction/submit fails. All counters are plain
 * fields mutated synchronously on the single-threaded event loop, so the
 * check-then-increment is atomic; a Redis-backed store would make it
 * distributed for the demo layer.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRenderJob, executeRenderJob } from '@hyperframes/producer';
import type { JobStore } from './job-store.js';
import type { ArtifactStore } from './artifact-store.js';
import type { RenderJobRecord, RenderOptions } from './types.js';
import { config } from './config.js';

/** Thrown when admission control rejects a submission (mapped to HTTP 429). */
export class RenderRejectedError extends Error {}

/** An accepted admission slot, returned by {@link RenderManager.reserve}. */
export interface Reservation {
  identity: string;
  consumed: boolean;
}

interface QueuedJob {
  record: RenderJobRecord;
  options: RenderOptions;
  abort: AbortController;
}

export class RenderManager {
  private running = 0;
  private readonly queue: QueuedJob[] = [];
  /** Live AbortControllers for queued/running jobs, keyed by jobId (for cancel). */
  private readonly controllers = new Map<string, AbortController>();
  /** Active (reserved + queued + running) count per identity, for the per-user guard. */
  private readonly activeByIdentity = new Map<string, number>();
  /** Reserved-but-not-yet-submitted count, included in the global queue-depth cap. */
  private pending = 0;

  constructor(
    private readonly jobs: JobStore,
    private readonly artifacts: ArtifactStore,
  ) {}

  /** Total jobs occupying the system: reserved + queued + running. */
  private get inSystem(): number {
    return this.pending + this.queue.length + this.running;
  }

  /**
   * Atomically claim an admission slot for `identity`, or throw
   * {@link RenderRejectedError}. Must be paired with {@link consume} (on
   * success) or {@link release} (on failure). Reserve before extracting the
   * archive so a rejected caller never triggers a decompression.
   */
  reserve(identity: string): Reservation {
    if (this.inSystem >= config.maxQueue) {
      throw new RenderRejectedError('The render queue is full; try again shortly.');
    }
    if (config.maxJobsPerUser > 0) {
      const active = this.activeByIdentity.get(identity) ?? 0;
      if (active >= config.maxJobsPerUser) {
        throw new RenderRejectedError(
          `A render is already in progress (limit ${config.maxJobsPerUser}).`,
        );
      }
    }
    this.activeByIdentity.set(identity, (this.activeByIdentity.get(identity) ?? 0) + 1);
    this.pending += 1;
    return { identity, consumed: false };
  }

  /** Release a reservation that will not become a job (extraction/submit failed). */
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

  /**
   * Enqueue a render against a held reservation. `projectDir` already contains
   * the unzipped project (with index.html). Returns the new jobId.
   */
  async submit(
    reservation: Reservation,
    projectDir: string,
    options: RenderOptions,
  ): Promise<string> {
    if (reservation.consumed) {
      throw new RenderRejectedError('Reservation already used');
    }
    // Convert the reservation into a real queued job: the identity count stays,
    // but it's no longer "pending".
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
    // If persisting the job fails, the identity slot claimed at reserve() would
    // otherwise leak (run() never runs to decrement it). Release it here.
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

  /** Cancel a queued or running job. */
  async cancel(id: string): Promise<boolean> {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    // If still queued (not yet running), drop it and finalize now.
    const queuedIdx = this.queue.findIndex((q) => q.record.id === id);
    if (queuedIdx >= 0) {
      const [q] = this.queue.splice(queuedIdx, 1);
      this.controllers.delete(id);
      if (q.record.userId) this.decrementIdentity(q.record.userId);
      await this.jobs.update(id, { status: 'cancelled', currentStage: 'cancelled' });
      await this.cleanupProject(q.record.projectDir);
    }
    return true;
  }

  /** Start as many queued jobs as the concurrency budget allows. */
  private pump(): void {
    while (this.running < config.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running++;
      // Fire-and-forget: run() owns its own error handling and always decrements.
      void this.run(next);
    }
  }

  private async run({ record, options, abort }: QueuedJob): Promise<void> {
    const { id, projectDir } = record;
    const outputPath = join(projectDir, 'output.mp4');
    // Wall-clock watchdog: abort a render that overruns the deadline so it can't
    // hold a concurrency slot + scratch dir indefinitely. executeRenderJob
    // honors the same AbortSignal we pass for user cancellation. `timedOut`
    // distinguishes a deadline abort (→ failed) from a user cancel (→ cancelled).
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, config.jobDeadlineMs);
    if (typeof deadline.unref === 'function') deadline.unref();
    try {
      await this.jobs.update(id, { status: 'running', currentStage: 'preparing' });

      const job = createRenderJob({
        fps: options.fps,
        quality: options.quality,
        format: options.format,
      });

      await executeRenderJob(
        job,
        projectDir,
        outputPath,
        async (j) => {
          // Producer mutates the same `job` object; mirror the fields we expose.
          // Producer's `progress` is 0..100; our HTTP contract is 0..1, so
          // normalize here (clamped) — success is set to 1 below.
          const progress =
            typeof j.progress === 'number' ? Math.max(0, Math.min(1, j.progress / 100)) : 0;
          await this.jobs.update(id, {
            status: 'running',
            progress,
            currentStage: j.currentStage || j.status,
            ...(typeof j.framesRendered === 'number' ? { framesRendered: j.framesRendered } : {}),
            ...(typeof j.totalFrames === 'number' ? { totalFrames: j.totalFrames } : {}),
          });
        },
        abort.signal,
      );

      if (abort.signal.aborted) {
        // Deadline overrun is a failure, not a user cancellation.
        await this.jobs.update(id, {
          status: timedOut ? 'failed' : 'cancelled',
          currentStage: timedOut ? 'failed' : 'cancelled',
          ...(timedOut ? { error: 'Render exceeded the deadline' } : {}),
        });
        await this.cleanupProject(projectDir);
        return;
      }

      await this.artifacts.put(id, outputPath);
      await this.jobs.update(id, {
        status: 'succeeded',
        progress: 1,
        currentStage: 'complete',
        outputPath,
      });
    } catch (error) {
      // A deadline abort surfaces as a thrown RenderCancelledError; report it as
      // failed (with a clear reason), reserving `cancelled` for user cancels.
      const cancelledByUser = abort.signal.aborted && !timedOut;
      await this.jobs.update(id, {
        status: cancelledByUser ? 'cancelled' : 'failed',
        currentStage: cancelledByUser ? 'cancelled' : 'failed',
        error: timedOut
          ? 'Render exceeded the deadline'
          : error instanceof Error
            ? error.message
            : String(error),
      });
      // On failure/cancel the artifact is worthless — reclaim the project dir now.
      await this.cleanupProject(projectDir);
    } finally {
      clearTimeout(deadline);
      this.controllers.delete(id);
      if (record.userId) this.decrementIdentity(record.userId);
      this.running--;
      this.pump();
    }
  }

  /** Best-effort recursive delete of a job's unzipped project dir. */
  async cleanupProject(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Create a fresh, empty per-render project directory under the configured tmp root. */
export async function makeProjectDir(): Promise<string> {
  return mkdtemp(join(config.tmpDir, 'render-'));
}
