/**
 * Marks a boot failure as a refused configuration.
 *
 * `instrumentation.ts` runs each fatal configuration check through
 * {@link runConfigurationCheck}, so what such a check throws is reported as
 * "Invalid server configuration" with its message alone (the message names the
 * setting and the fix). Anything else that fails during boot — a module that
 * cannot be loaded (for example a chunk missing from a standalone build) or a
 * bug in startup code — is not marked, and is reported with its stack instead
 * (see `lib/server/boot-failure.ts`).
 */

const BRAND = Symbol.for('openmaic.boot.invalid-configuration');

export class InvalidBootConfigurationError extends Error {
  readonly [BRAND] = true;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'InvalidBootConfigurationError';
  }
}

/**
 * Whether `error` is a refused configuration. Checked by brand, not by
 * `instanceof`, so a second copy of this module (bundling, test module resets)
 * still recognizes it.
 */
export function isInvalidBootConfigurationError(
  error: unknown,
): error is InvalidBootConfigurationError {
  return (
    typeof error === 'object' && error !== null && (error as { [BRAND]?: unknown })[BRAND] === true
  );
}

/**
 * Run one configuration check; a throw from it is a refused configuration and
 * is rethrown as an {@link InvalidBootConfigurationError} carrying the same
 * message (the original error is its `cause`).
 */
export function runConfigurationCheck(check: () => unknown): void {
  try {
    check();
  } catch (error) {
    throw new InvalidBootConfigurationError(error);
  }
}
