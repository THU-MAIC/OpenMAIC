/**
 * A one-time startup warning for the previous name of the workbench flag.
 *
 * `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED` was renamed to
 * `NEXT_PUBLIC_WORKBENCH_ENABLED`. The old name is still read, when the new
 * one is unset or empty, until 1.6.0 (see `isWorkbenchEnabled` in
 * `lib/config/feature-flags.ts`). This warns exactly when that fallback is
 * taken, so a deployment learns of the rename before the old name stops
 * working. A warning, never a boot failure.
 *
 * Both names are read as literal `process.env.NEXT_PUBLIC_*` accesses, which
 * Next.js inlines at build time like the flag itself, so the warning reflects
 * the values the running build was compiled with.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('FeatureFlags');

let warned = false;

/** Warn once when the workbench flag is read from its previous name. */
export function warnIfDeprecatedWorkbenchFlagIsUsed(): void {
  if (warned) return;
  const current = process.env.NEXT_PUBLIC_WORKBENCH_ENABLED;
  if (current !== undefined && current !== '') return;
  const previous = process.env.NEXT_PUBLIC_PRO_WORKBENCH_ENABLED;
  if (previous === undefined || previous === '') return;
  warned = true;
  log.warn(
    'NEXT_PUBLIC_PRO_WORKBENCH_ENABLED is deprecated and will be removed in 1.6.0. ' +
      'Rename it to NEXT_PUBLIC_WORKBENCH_ENABLED and rebuild.',
  );
}

/** Reset the once-per-process guard. Exists mainly for tests. */
export function resetWorkbenchFlagDeprecationWarningForTests(): void {
  warned = false;
}
