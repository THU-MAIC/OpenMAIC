/**
 * Config — every knob the render service reads from the environment, resolved
 * once at import. Defaults suit an OSS single-host deployment; the demo layer
 * only tunes values (and, later, points the store factories at Redis/S3).
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

const MB = 1024 * 1024;

export const config = {
  port: intEnv('PORT', 9000),
  /** Renders that execute simultaneously; extras queue FIFO. */
  maxConcurrency: intEnv('RENDER_MAX_CONCURRENCY', 2),
  /**
   * Archives extracted simultaneously. Extraction holds the expanded archive in
   * memory, so this bounds the RAM multiplier (≈ this × maxExpandedBytes) even
   * when many jobs are admitted at once. Defaults to the render concurrency.
   */
  maxConcurrentExtractions: intEnv('RENDER_MAX_CONCURRENT_EXTRACTIONS', 2),
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
