import { createAnonymousCookieAuthenticator } from './anonymous-cookie';
import { createSharedTeamAuthenticator, resolveSharedOwnerId } from './shared-team';
import {
  createTrustedProxyAuthenticator,
  resetTrustedProxyWarningsForTests,
  resolveTrustedProxyConfig,
  trustedProxyModeSelected,
  warnAboutTrustedProxyAdminGroups,
} from './trusted-proxy';
import type { OwnerAuthenticator } from './types';

/**
 * Which {@link OwnerAuthenticator} this process uses.
 *
 * Unconfigured — the default — the built-ins are chosen from the environment
 * on every request: `OWNER_AUTHENTICATOR=trusted-proxy` selects
 * `trustedProxyHeader` (`./trusted-proxy.ts`), `PERSISTENCE_SHARED_OWNER_ID`
 * (validated, and requiring `ACCESS_CODE`) selects `sharedTeam`, otherwise
 * `anonymousCookie`. The two variables exclude each other. Reading the environment
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
  const trustedProxy = resolveTrustedProxyConfig();
  if (trustedProxy) return createTrustedProxyAuthenticator(trustedProxy);
  const sharedOwnerId = resolveSharedOwnerId();
  return sharedOwnerId ? createSharedTeamAuthenticator(sharedOwnerId) : anonymousCookie;
}

/** The environment-selected built-ins, re-evaluated per request. */
const defaultOwnerAuthenticator: OwnerAuthenticator = {
  name: 'default',
  authenticate: async (req) => builtInFromEnvironment().authenticate(req),
  authenticateFromContext: async () => {
    const selected = builtInFromEnvironment();
    // Every built-in implements it; the check keeps the type honest.
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
 * authenticator, or while `PERSISTENCE_SHARED_OWNER_ID` or
 * `OWNER_AUTHENTICATOR` is set (each configures a built-in that this call
 * replaces, so accepting both would silently ignore one of them).
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
  if (process.env.OWNER_AUTHENTICATOR?.trim()) {
    throw new Error(
      'OWNER_AUTHENTICATOR selects a built-in authenticator and cannot be combined with a ' +
        `configured authenticator (${authenticator.name}). Unset it.`,
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

/** Which authenticator a validated configuration resolves owners with. */
export type OwnerIdentityMode =
  | 'configured'
  | 'trustedProxyHeader'
  | 'sharedTeam'
  | 'anonymousCookie';

/**
 * Boot-time validation, called from `instrumentation.ts`. A malformed
 * `PERSISTENCE_SHARED_OWNER_ID`, one set without `ACCESS_CODE`, or a
 * trusted-proxy configuration without a usable secret would otherwise boot,
 * pass its health check, and then fail — or silently mis-identify — every
 * owner-scoped request; throwing here makes the deployment fail to start
 * instead. The built-in variables are validated even when a host authenticator
 * is configured, so a leftover one is reported rather than ignored.
 */
export function validateOwnerIdentityConfiguration(): OwnerIdentityMode {
  const configured = registry().configured;
  if (configured && trustedProxyModeSelected()) {
    throw new Error(
      `OWNER_AUTHENTICATOR cannot be combined with a configured authenticator (${configured.name}).`,
    );
  }
  const trustedProxy = resolveTrustedProxyConfig();
  const sharedOwnerId = resolveSharedOwnerId();
  if (configured) return 'configured';
  if (trustedProxy) {
    warnAboutTrustedProxyAdminGroups(trustedProxy);
    return 'trustedProxyHeader';
  }
  return sharedOwnerId ? 'sharedTeam' : 'anonymousCookie';
}

export function resetOwnerAuthenticatorForTests(): void {
  delete globalState[REGISTRY_KEY];
  resetTrustedProxyWarningsForTests();
}
