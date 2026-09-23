import { createAnonymousCookieAuthenticator } from './anonymous-cookie';
import { createSharedTeamAuthenticator, resolveSharedOwnerId } from './shared-team';
import type { OwnerAuthenticator } from './types';

/**
 * Which {@link OwnerAuthenticator} this process uses.
 *
 * Unconfigured — the default — the built-ins are chosen from the environment
 * on every request, exactly as owner resolution always worked:
 * `PERSISTENCE_SHARED_OWNER_ID` (validated, and requiring `ACCESS_CODE`)
 * selects `sharedTeam`, otherwise `anonymousCookie`. Reading the environment
 * per call keeps a value changed for a test observable without a module reload.
 *
 * A host replaces that choice once, at server bootstrap, with
 * {@link configureOwnerAuthenticator}; `instrumentation.ts` is the place.
 *
 * The state lives on `globalThis` because Next can evaluate this module more
 * than once in one process (the instrumentation hook and route bundles), and
 * all of them must see the one registration.
 */

interface RegistryState {
  configured?: OwnerAuthenticator;
  /** Set by the first lookup; configuring after it would split one process across two identities. */
  inUse?: boolean;
}

const REGISTRY_KEY = Symbol.for('openmaic.owner-identity.registry');
const globalState = globalThis as typeof globalThis & { [REGISTRY_KEY]?: RegistryState };
function registry(): RegistryState {
  return (globalState[REGISTRY_KEY] ??= {});
}

const anonymousCookie = createAnonymousCookieAuthenticator();

function builtInFromEnvironment(): OwnerAuthenticator {
  const sharedOwnerId = resolveSharedOwnerId();
  return sharedOwnerId ? createSharedTeamAuthenticator(sharedOwnerId) : anonymousCookie;
}

/** The environment-selected built-ins, re-evaluated per request. */
const defaultOwnerAuthenticator: OwnerAuthenticator = {
  name: 'default',
  authenticate: async (req) => builtInFromEnvironment().authenticate(req),
  authenticateFromContext: async () => {
    const selected = builtInFromEnvironment();
    // Both built-ins implement it; the check keeps the type honest.
    if (!selected.authenticateFromContext) {
      throw new Error(`${selected.name} cannot resolve a Server Action owner`);
    }
    return selected.authenticateFromContext();
  },
};

/**
 * Register the process-wide owner authenticator. Server-only, and single-shot:
 * call it once from `instrumentation.ts` `register()` before the server serves
 * a request. Throws — failing the boot — when called twice, after owner
 * resolution has already started, with something that is not an
 * authenticator, or while `PERSISTENCE_SHARED_OWNER_ID` is set (the variable
 * configures a built-in that this call replaces, so accepting both would
 * silently ignore one of them).
 */
export function configureOwnerAuthenticator(authenticator: OwnerAuthenticator): void {
  if (typeof window !== 'undefined') {
    throw new Error('configureOwnerAuthenticator is server-only');
  }
  const state = registry();
  if (state.configured) {
    throw new Error(
      `An owner authenticator is already configured (${state.configured.name}); ` +
        'configureOwnerAuthenticator may be called once per process.',
    );
  }
  if (state.inUse) {
    throw new Error(
      'configureOwnerAuthenticator was called after owner resolution started. Call it from ' +
        'instrumentation.ts register(), before the server serves a request.',
    );
  }
  if (
    !authenticator ||
    typeof authenticator.name !== 'string' ||
    !authenticator.name ||
    typeof authenticator.authenticate !== 'function' ||
    (authenticator.authenticateFromContext !== undefined &&
      typeof authenticator.authenticateFromContext !== 'function')
  ) {
    throw new Error(
      'configureOwnerAuthenticator expects { name, authenticate(req), authenticateFromContext?() }',
    );
  }
  if (process.env.PERSISTENCE_SHARED_OWNER_ID?.trim()) {
    throw new Error(
      'PERSISTENCE_SHARED_OWNER_ID selects the built-in shared-team authenticator and cannot be ' +
        `combined with a configured authenticator (${authenticator.name}). Unset it.`,
    );
  }
  state.configured = authenticator;
}

/** The authenticator owner resolution uses: the configured one, else the built-ins. */
export function getOwnerAuthenticator(): OwnerAuthenticator {
  const state = registry();
  state.inUse = true;
  return state.configured ?? defaultOwnerAuthenticator;
}

/**
 * Boot-time validation, called from `instrumentation.ts`. A malformed
 * `PERSISTENCE_SHARED_OWNER_ID`, or one set without `ACCESS_CODE`, would
 * otherwise boot, pass its health check, and then fail every owner-scoped
 * request; throwing here makes the deployment fail to start instead.
 */
export function validateOwnerIdentityConfiguration(): void {
  resolveSharedOwnerId();
}

export function resetOwnerAuthenticatorForTests(): void {
  delete globalState[REGISTRY_KEY];
}
