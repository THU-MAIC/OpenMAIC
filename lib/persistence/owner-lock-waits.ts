/**
 * How long owner writes and claims wait for identity locks
 * (`./owner-merges.ts`, `./owner-claims.ts`). Dependency-free, so boot
 * validation (`validateOwnerIdentityConfiguration`) can check the same values
 * the lock paths read, and a malformed one stops the server instead of failing
 * every write.
 */

/** A write waits this long for its owner's identity lock (`OWNER_WRITE_LOCK_WAIT_MS`). */
export const DEFAULT_WRITE_LOCK_WAIT_MS = 30_000;
/** A claim waits this long for its two identity locks (`OWNER_CLAIM_LOCK_WAIT_MS`). */
export const DEFAULT_CLAIM_LOCK_WAIT_MS = 5_000;

/** A positive integer of milliseconds from `variable`, or `fallback` when unset or blank. */
export function resolveLockWaitMs(variable: string, fallback: number): number {
  const raw = process.env[variable]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      `${variable} must be a positive integer number of milliseconds, got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

export const resolveWriteLockWaitMs = () =>
  resolveLockWaitMs('OWNER_WRITE_LOCK_WAIT_MS', DEFAULT_WRITE_LOCK_WAIT_MS);
export const resolveClaimLockWaitMs = () =>
  resolveLockWaitMs('OWNER_CLAIM_LOCK_WAIT_MS', DEFAULT_CLAIM_LOCK_WAIT_MS);
