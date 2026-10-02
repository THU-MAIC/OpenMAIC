/**
 * One-time operator warnings for missing or short `ACCESS_CODE` values.
 * Emitted through the repo logger; neither warning contains the code itself.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('AccessCode');

/** Minimum recommended access-code length; documented in README and .env.example. */
export const ACCESS_CODE_MIN_RECOMMENDED_LENGTH = 16;

let warned = false;
let warnedUnset = false;

/**
 * The startup hook has no public API for the actual listening address. In
 * particular, `next dev` and `next start` ignore HOSTNAME and default to a
 * wildcard bind. Warn conservatively even when network exposure is unknown,
 * rather than interpreting a missing/loopback HOSTNAME as a safe deployment.
 * Keep the same truthiness check as middleware: do not trim the access code.
 */
export function warnIfAccessCodeIsUnset(accessCode: string | undefined): void {
  if (accessCode || warnedUnset) return;

  warnedUnset = true;
  log.warn(
    'ACCESS_CODE is not set. The access-code gate is disabled for all API routes. ' +
      'Set ACCESS_CODE to a long random value (at least ' +
      `${ACCESS_CODE_MIN_RECOMMENDED_LENGTH} characters) before exposing this server to a network.`,
  );
}

/**
 * Log at most one warning per process when `accessCode` is shorter than
 * {@link ACCESS_CODE_MIN_RECOMMENDED_LENGTH}. Called from the Node verify route,
 * not from Edge middleware. A code at or above the threshold logs nothing.
 *
 * Length is measured in Unicode code points, not UTF-16 code units, so an
 * emoji-heavy code is not silently treated as twice its real length.
 */
export function warnIfAccessCodeIsShort(accessCode: string): void {
  if (warned) return;
  if ([...accessCode].length >= ACCESS_CODE_MIN_RECOMMENDED_LENGTH) return;

  warned = true;
  log.warn(
    `ACCESS_CODE is shorter than ${ACCESS_CODE_MIN_RECOMMENDED_LENGTH} characters. ` +
      'Use a long random value so the code cannot be brute-forced.',
  );
}

/** Reset the once-per-process guard. Exists mainly for tests. */
export function resetAccessCodeWarningForTests(): void {
  warned = false;
  warnedUnset = false;
}
