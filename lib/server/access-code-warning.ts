/**
 * One-time operator warning when the configured `ACCESS_CODE` is too short to
 * resist brute force. It is emitted through the repo logger and never contains
 * the code itself.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('AccessCode');

/** Minimum recommended access-code length; documented in README and .env.example. */
export const ACCESS_CODE_MIN_RECOMMENDED_LENGTH = 16;

let warned = false;

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
}
