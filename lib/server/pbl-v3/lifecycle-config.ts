/** Business inactivity is independent of the provider's renewable resource lease. */
export function pblIdleTimeoutMs() {
  const value = Number(process.env.OPENMAIC_PBL_IDLE_TIMEOUT_MS ?? 900_000);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 86_400_000)
    throw new Error('OPENMAIC_PBL_IDLE_TIMEOUT_MS must be between 60000 and 86400000.');
  return value;
}

/** Archive/terminal/command failure grace; retries never extend a started cycle. */
export function pblArchiveFailureGraceMs() {
  const value = Number(process.env.OPENMAIC_PBL_ARCHIVE_FAILURE_GRACE_MS ?? 300_000);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 86_400_000)
    throw new Error('OPENMAIC_PBL_ARCHIVE_FAILURE_GRACE_MS must be between 60000 and 86400000.');
  return value;
}

export const PBL_LIFECYCLE_INTERVAL_MS = 30_000;
export const PBL_DIRTY_CHECKPOINT_MS = 60_000;
export const PBL_MAX_COMMAND_MS = 330_000;
