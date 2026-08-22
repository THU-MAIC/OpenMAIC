/**
 * Config — every knob the render service reads from the environment, resolved
 * once at import. Defaults suit an OSS single-host deployment; the demo layer
 * only tunes values (and, later, points the store factories at Redis/S3).
 */
import { resolveResourceProfile } from './resource-profile.js';

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boundedIntEnv(name: string, fallback: number, maximum: number): number {
  const value = intEnv(name, fallback);
  if (value > maximum) {
    throw new Error(`${name}=${value} exceeds the resource profile limit of ${maximum}`);
  }
  return value;
}

/**
 * Like {@link intEnv} but accepts 0 as a valid value (still rejects negatives /
 * non-numeric). Used for knobs where 0 has a distinct meaning — e.g. a per-user
 * limit of 0 disables the guard entirely, as documented.
 */
function intEnvAllowZero(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'off') return false;
  return fallback;
}

const MB = 1024 * 1024;
const resourceProfile = resolveResourceProfile();

export const config = {
  port: intEnv('PORT', 9000),
  resourceProfile,
  /** Renders that execute simultaneously; fixed by the selected resource profile. */
  maxConcurrency: resourceProfile.maxConcurrency,
  /**
   * Archives extracted simultaneously. Extraction holds the expanded archive in
   * memory, so this bounds the RAM multiplier (≈ this × maxExpandedBytes) even
   * when many jobs are admitted at once. Defaults to the render concurrency.
   */
  maxConcurrentExtractions: resourceProfile.maxConcurrentExtractions,
  /** Explicit per-job worker count fixed by the selected resource profile. */
  producerWorkers: resourceProfile.producerWorkers,
  /** Opt-in local plan → chunk → assemble path; HTTP contract remains unchanged. */
  chunkExecutionEnabled: boolEnv('RENDER_CHUNK_EXECUTION', false),
  chunkCount: intEnv('RENDER_CHUNK_COUNT', 1),
  chunkWorkers: boundedIntEnv(
    'RENDER_CHUNK_WORKERS',
    resourceProfile.producerWorkers,
    resourceProfile.maxChunkWorkers,
  ),
  maxParallelChunks: boundedIntEnv(
    'RENDER_MAX_PARALLEL_CHUNKS',
    1,
    resourceProfile.maxParallelChunks,
  ),
  /** Optional fixed frame count for each planned chunk. */
  chunkSizeFrames: intEnv('RENDER_CHUNK_SIZE_FRAMES', 0),
  /** Optional target frame count used by the producer planner. */
  targetChunkFrames: intEnv('RENDER_TARGET_CHUNK_FRAMES', 0),
  /** Explicit false guard so inherited env cannot turn screenshot fallback rejection back on. */
  requireBeginFrame: resourceProfile.requireBeginFrame,
  /** Active (queued+running) jobs allowed per client identity. 0 disables the guard. */
  maxJobsPerUser: intEnvAllowZero('RENDER_MAX_JOBS_PER_USER', 1),
  /** Max jobs allowed in the system (queued+running) before new submits are rejected. */
  maxQueue: intEnv('RENDER_MAX_QUEUE', 20),
  /** How long a finished job's record + artifacts live before the sweeper reaps them. */
  jobTtlMs: intEnv('RENDER_JOB_TTL_MS', 30 * 60 * 1000),
  /**
   * Hard per-job wall-clock deadline. A render exceeding this is aborted and
   * marked failed so a hung job can't hold a concurrency slot + scratch forever.
   */
  jobDeadlineMs: intEnv('RENDER_JOB_DEADLINE_MS', 45 * 60 * 1000),
  /** Root dir for unzipped projects and rendered outputs. */
  tmpDir: process.env.PRODUCER_TMP_PROJECT_DIR || '/tmp/openmaic-renders',

  // ---- Archive limits (ZIP-bomb / DoS guards, enforced before extraction) ----
  /** Max compressed upload size accepted (bytes). */
  maxUploadBytes: intEnv('RENDER_MAX_UPLOAD_BYTES', 300 * MB),
  /** Max number of entries in the archive. */
  maxEntries: intEnv('RENDER_MAX_ENTRIES', 5000),
  /** Max expanded size of any single entry (bytes). */
  maxEntryBytes: intEnv('RENDER_MAX_ENTRY_BYTES', 200 * MB),
  /** Max total expanded size across all entries (bytes). */
  maxExpandedBytes: intEnv('RENDER_MAX_EXPANDED_BYTES', 512 * MB),
  /** Max expanded:compressed ratio for a single entry (catches deep-compression bombs). */
  maxCompressionRatio: intEnv('RENDER_MAX_COMPRESSION_RATIO', 200),
} as const;
