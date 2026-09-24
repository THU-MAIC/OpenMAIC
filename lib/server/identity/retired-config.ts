/**
 * Configuration of the removed built-in gateway-header authenticator.
 *
 * `OWNER_AUTHENTICATOR` and the `TRUSTED_PROXY_*` variables used to select
 * and configure a built-in that trusted a gateway's user header. It is gone
 * (a host registers an owner auth method instead; the README has a recipe for
 * gateway-signed tokens), so these variables no longer do anything. Left in a
 * deployment's environment they would make an operator believe accounts are
 * on while every request resolves to an anonymous owner, so boot fails
 * instead.
 *
 * Only the variable names are matched here; their values are never used.
 * This is the one module allowed to name them
 * (`tests/server/identity/cookie-guard.test.ts`).
 */

const RETIRED_NAME = /^(?:OWNER_AUTHENTICATOR|TRUSTED_PROXY_[A-Z0-9_]*)$/;

/** Throws when any retired identity variable is set to a non-blank value. */
export function assertNoRetiredIdentityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const found = Object.entries(environment)
    .filter(([name, value]) => RETIRED_NAME.test(name) && value !== undefined && value.trim())
    .map(([name]) => name)
    .sort();
  if (found.length === 0) return;
  throw new Error(
    `${found.join(', ')} ${found.length === 1 ? 'is' : 'are'} set, but the built-in ` +
      'gateway-header authenticator was removed and these variables no longer do anything: ' +
      'every request would resolve to an anonymous owner. Register an owner auth method ' +
      'instead (README "Owner identity", including the recipe for gateway-signed tokens), ' +
      `and unset ${found.length === 1 ? 'it' : 'them'}.`,
  );
}
