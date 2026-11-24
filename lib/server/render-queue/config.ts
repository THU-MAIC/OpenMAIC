/**
 * Configuration of the durable video export queue.
 *
 * `RENDER_DURABLE_QUEUE=true` moves video export jobs out of the render
 * service's memory: the app keeps each job in PostgreSQL and its archive and
 * MP4 in the asset byte store, and a runner in every app process sends jobs
 * to the render service only while its `/health` reports `accepting`. Off by
 * default; with it off the export routes relay to the render service as
 * before.
 */
import { getRenderServiceUrl } from '@/lib/server/render-service';

function nonNegativeIntegerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** The durable queue is on, and there is a render service to send jobs to. */
export function isRenderDurableQueueEnabled(): boolean {
  return process.env.RENDER_DURABLE_QUEUE?.trim() === 'true' && getRenderServiceUrl() !== null;
}

export interface RenderQueueConfig {
  /** Jobs not yet finished (uploading, queued or rendering) across the deployment. */
  maxJobs: number;
  /** Unfinished jobs one owner may hold; 0 for no limit. */
  maxJobsPerOwner: number;
  scanIntervalMs: number;
  /** How often a followed job's status is read from the render service. */
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  /** A lease with an older heartbeat is orphaned and taken over. */
  leaseTtlMs: number;
  /** The render service unreachable for this long means the job is lost. */
  lostAfterMs: number;
  /** Dispatches of one job before a lost job fails instead of being sent again. */
  maxAttempts: number;
  /** Jobs one app process dispatches or follows at once. */
  maxConcurrent: number;
  /** How long a finished job, and its MP4, stays downloadable. */
  retentionMs: number;
  /** An upload not finished for this long is abandoned and its parts deleted. */
  staleUploadMs: number;
  sweepIntervalMs: number;
}

/** Read on every call, so a test (or an operator restart) sees the environment as it is. */
export function renderQueueConfig(): RenderQueueConfig {
  return {
    maxJobs: nonNegativeIntegerFromEnv('RENDER_QUEUE_MAX_JOBS', 20),
    maxJobsPerOwner: nonNegativeIntegerFromEnv('RENDER_QUEUE_MAX_JOBS_PER_OWNER', 1),
    scanIntervalMs: 2000,
    pollIntervalMs: 5000,
    heartbeatIntervalMs: 10_000,
    leaseTtlMs: 120_000,
    lostAfterMs: 60_000,
    maxAttempts: 2,
    maxConcurrent: 8,
    retentionMs: 30 * 60 * 1000,
    staleUploadMs: 10 * 60 * 1000,
    sweepIntervalMs: 60_000,
  };
}
