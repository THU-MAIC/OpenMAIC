import { createHash, timingSafeEqual } from 'node:crypto';

import { createLogger } from '@/lib/logger';

import type { AuthOutcome, OwnerAuthenticator, OwnerPrincipal } from './types';
import { isStorableOwnerId, OWNER_ROLES } from './types';

/**
 * The `trustedProxyHeader` built-in: real accounts through an identity gateway.
 *
 * A gateway in front of OpenMAIC (oauth2-proxy, Authelia, a Keycloak-based
 * proxy, an institutional reverse proxy) signs the user in against the
 * organization's identity provider and forwards the verified user in a request
 * header. OpenMAIC never sees a password or a token; it trusts that header, and
 * only that header, when the request proves it came through the gateway.
 *
 * ## The trust boundary is a shared secret
 *
 * The request must carry a secret the gateway injects (`TRUSTED_PROXY_SECRET`,
 * in `x-openmaic-proxy-secret` by default). A peer-address allowlist is not
 * offered: Next.js does not expose the TCP peer to route handlers, middleware
 * or Server Actions. The only peer-derived value is `x-forwarded-for`, which
 * the Next server fills from the socket only when the client did not send one,
 * so a client chooses it. A trust decision based on it would be a decision the
 * client makes. The secret is compared in constant time and is required: this
 * authenticator refuses to boot without one.
 *
 * The secret proves the gateway handled the request; it does not replace
 * network isolation. The deployment must also make the app reachable only
 * through the gateway, and the gateway must strip any client-supplied copy of
 * the user, groups and secret headers before it sets its own.
 *
 * ## Per request
 *
 * - Missing or wrong secret: 401 `INVALID_CREDENTIAL`, never an anonymous owner.
 * - Valid secret, missing or blank user header: 401.
 * - A user header with a comma: 401. Duplicate header lines arrive joined with
 *   `", "`, and which of two users is meant is not ours to guess.
 * - The owner id is `proxy:<user>`. A user that yields an id outside the
 *   storable 1-256 printable non-space ASCII range is a 401 as well: the value
 *   came with the request, so it is a credential this deployment cannot accept,
 *   not a server fault (a host authenticator that returns such an id is a 500).
 * - The user is trimmed and otherwise kept verbatim, including case: identity
 *   providers differ on whether subject ids are case-sensitive, and folding
 *   case could merge two distinct accounts into one owner.
 * - Every gateway user holds `course:publish` (OpenMAIC has one surface where
 *   the same person creates and learns). Membership in one of
 *   `TRUSTED_PROXY_ADMIN_GROUPS`, read from the optional groups header, adds
 *   `admin`.
 * - No cookie is set.
 */

const log = createLogger('OwnerIdentity');

/** The selector value that turns this authenticator on. */
export const TRUSTED_PROXY_MODE = 'trusted-proxy';
const MODE_ENV = 'OWNER_AUTHENTICATOR';
const SECRET_ENV = 'TRUSTED_PROXY_SECRET';
const SECRET_HEADER_ENV = 'TRUSTED_PROXY_SECRET_HEADER';
const USER_HEADER_ENV = 'TRUSTED_PROXY_USER_HEADER';
const GROUPS_HEADER_ENV = 'TRUSTED_PROXY_GROUPS_HEADER';
const ADMIN_GROUPS_ENV = 'TRUSTED_PROXY_ADMIN_GROUPS';
const TRUSTED_PROXY_ENVS = [
  SECRET_ENV,
  SECRET_HEADER_ENV,
  USER_HEADER_ENV,
  GROUPS_HEADER_ENV,
  ADMIN_GROUPS_ENV,
] as const;

export const DEFAULT_TRUSTED_PROXY_SECRET_HEADER = 'x-openmaic-proxy-secret';
export const DEFAULT_TRUSTED_PROXY_USER_HEADER = 'x-forwarded-user';

/** Long enough that guessing is not an attack; short secrets are refused at boot. */
export const TRUSTED_PROXY_SECRET_MIN_LENGTH = 32;
const TRUSTED_PROXY_SECRET_MAX_LENGTH = 1024;
/** The secret rides in a header, where surrounding whitespace is trimmed away. */
const SECRET_PATTERN = /^[\x21-\x7e]+$/;
/** An HTTP field name (RFC 9110 token). */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
/**
 * Headers that HTTP, the framework or a forwarding proxy give their own
 * meaning. Next.js sets or rewrites its internal headers between middleware
 * and the handler, and proxies set the forwarding ones from the connection or
 * pass a client's value through, so none of them can carry the gateway's
 * user, groups or secret.
 */
const RESERVED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'forwarded',
  'host',
  'next-action',
  'rsc',
  'set-cookie',
  'transfer-encoding',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);
/** Framework-internal header families, reserved by prefix. */
const RESERVED_HEADER_PREFIXES = ['next-router-', 'x-invoke-', 'x-middleware-', 'x-nextjs-'];

function reservedHeader(name: string): boolean {
  return (
    RESERVED_HEADERS.has(name) || RESERVED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Groups past these bounds are ignored, which can only withhold a role. */
export const TRUSTED_PROXY_MAX_GROUPS = 256;
export const TRUSTED_PROXY_MAX_GROUP_LENGTH = 256;

const OWNER_ID_PREFIX = 'proxy:';

export interface TrustedProxyConfig {
  readonly secret: string;
  readonly secretHeader: string;
  readonly userHeader: string;
  readonly groupsHeader?: string;
  readonly adminGroups: ReadonlySet<string>;
}

function env(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

function headerName(variable: string, fallback?: string): string | undefined {
  const raw = env(variable)?.trim().toLowerCase() ?? fallback;
  if (raw === undefined) return undefined;
  if (!HEADER_NAME_PATTERN.test(raw)) {
    throw new Error(`${variable} must be an HTTP header name, got ${JSON.stringify(raw)}.`);
  }
  if (reservedHeader(raw)) {
    throw new Error(
      `${variable} names ${JSON.stringify(raw)}, a header that HTTP, Next.js or a forwarding ` +
        `proxy sets itself. Reserved: ${[...RESERVED_HEADERS].join(', ')}, and names starting ` +
        `with ${RESERVED_HEADER_PREFIXES.join(', ')}.`,
    );
  }
  return raw;
}

function commaList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Whether `OWNER_AUTHENTICATOR` selects this authenticator. Any other
 * non-blank value is refused, so a typo cannot boot the anonymous default.
 */
export function trustedProxyModeSelected(): boolean {
  const mode = env(MODE_ENV)?.trim();
  if (mode === undefined) return false;
  if (mode !== TRUSTED_PROXY_MODE) {
    throw new Error(
      `${MODE_ENV} must be "${TRUSTED_PROXY_MODE}" or unset, got ${JSON.stringify(mode)}.`,
    );
  }
  return true;
}

/**
 * The trusted-proxy configuration, or `undefined` when the deployment does not
 * use it. Read from the environment on each call, like the shared owner id, and
 * validated at boot by `instrumentation.ts`, so every mistake below fails the
 * deployment instead of its requests:
 *
 * - `OWNER_AUTHENTICATOR` set to anything but `trusted-proxy`;
 * - a `TRUSTED_PROXY_*` variable set while the mode is off (the operator
 *   believes accounts are on while every visitor would be anonymous);
 * - `PERSISTENCE_SHARED_OWNER_ID` set as well (two built-ins at once);
 * - a missing, short, over-long or non-printable `TRUSTED_PROXY_SECRET`;
 * - a malformed, reserved or repeated header name;
 * - `TRUSTED_PROXY_ADMIN_GROUPS` without a groups header, or with no group in it.
 */
export function resolveTrustedProxyConfig(): TrustedProxyConfig | undefined {
  if (!trustedProxyModeSelected()) {
    const stray = TRUSTED_PROXY_ENVS.filter((name) => env(name) !== undefined);
    if (stray.length) {
      throw new Error(
        `${stray.join(', ')} ${stray.length === 1 ? 'is' : 'are'} set but ${MODE_ENV} is not ` +
          `"${TRUSTED_PROXY_MODE}", so every request would be an anonymous owner. Set ` +
          `${MODE_ENV}=${TRUSTED_PROXY_MODE}, or unset ${stray.length === 1 ? 'it' : 'them'}.`,
      );
    }
    return undefined;
  }
  if (env('PERSISTENCE_SHARED_OWNER_ID') !== undefined) {
    throw new Error(
      `${MODE_ENV}=${TRUSTED_PROXY_MODE} and PERSISTENCE_SHARED_OWNER_ID select two different ` +
        'owner authenticators. Unset one of them.',
    );
  }

  const secret = process.env[SECRET_ENV] ?? '';
  if (!secret.trim()) {
    throw new Error(
      `${MODE_ENV}=${TRUSTED_PROXY_MODE} requires ${SECRET_ENV}: the gateway sends it with every ` +
        'request, and it is what tells a gateway request from a client forging the user header.',
    );
  }
  if (
    secret.length < TRUSTED_PROXY_SECRET_MIN_LENGTH ||
    secret.length > TRUSTED_PROXY_SECRET_MAX_LENGTH ||
    !SECRET_PATTERN.test(secret)
  ) {
    throw new Error(
      `${SECRET_ENV} must be ${TRUSTED_PROXY_SECRET_MIN_LENGTH}-${TRUSTED_PROXY_SECRET_MAX_LENGTH} ` +
        'printable ASCII characters without spaces (for example `openssl rand -hex 32`).',
    );
  }

  const secretHeader = headerName(SECRET_HEADER_ENV, DEFAULT_TRUSTED_PROXY_SECRET_HEADER)!;
  const userHeader = headerName(USER_HEADER_ENV, DEFAULT_TRUSTED_PROXY_USER_HEADER)!;
  const groupsHeader = headerName(GROUPS_HEADER_ENV);
  const names = [secretHeader, userHeader, ...(groupsHeader ? [groupsHeader] : [])];
  if (new Set(names).size !== names.length) {
    throw new Error(
      `${SECRET_HEADER_ENV}, ${USER_HEADER_ENV} and ${GROUPS_HEADER_ENV} must name different ` +
        `headers, got ${names.join(', ')}.`,
    );
  }

  const adminGroupsRaw = env(ADMIN_GROUPS_ENV);
  const adminGroups = new Set(adminGroupsRaw ? commaList(adminGroupsRaw) : []);
  if (adminGroupsRaw !== undefined) {
    if (!groupsHeader) {
      throw new Error(`${ADMIN_GROUPS_ENV} requires ${GROUPS_HEADER_ENV}.`);
    }
    if (adminGroups.size === 0) {
      throw new Error(`${ADMIN_GROUPS_ENV} must list at least one group, comma-separated.`);
    }
  }

  return { secret, secretHeader, userHeader, groupsHeader, adminGroups };
}

/**
 * Constant-time secret comparison. Both sides are hashed first, so the
 * comparison takes the same time whatever the presented value's length or
 * content, and `timingSafeEqual` never sees buffers of different sizes.
 */
export function trustedProxySecretMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

const ADMIN_GROUPS_WARNED = Symbol.for('openmaic.owner-identity.trusted-proxy.admin-warned');
const warnState = globalThis as typeof globalThis & { [ADMIN_GROUPS_WARNED]?: boolean };

/**
 * Called once at boot. The `admin` role is granted from the groups header, and
 * nothing but the shared secret proves where that header came from: a gateway
 * that injects the secret but passes a client's groups header through would let
 * the client name its own groups. Say so where the operator will see it.
 */
export function warnAboutTrustedProxyAdminGroups(config: TrustedProxyConfig): void {
  if (!config.adminGroups.size || warnState[ADMIN_GROUPS_WARNED]) return;
  warnState[ADMIN_GROUPS_WARNED] = true;
  log.warn(
    `WARNING: ${ADMIN_GROUPS_ENV} grants the admin role from the ${config.groupsHeader} ` +
      'header, which is trusted on the strength of the shared secret alone. The gateway MUST ' +
      'overwrite or strip any client-supplied copy of that header on every request; otherwise ' +
      'any client that reaches the app through the gateway can grant itself admin.',
  );
}

export function resetTrustedProxyWarningsForTests(): void {
  delete warnState[ADMIN_GROUPS_WARNED];
}

const INVALID: AuthOutcome = { ok: false, status: 401, code: 'INVALID_CREDENTIAL' };

function groupsFrom(raw: string | null): string[] {
  if (!raw) return [];
  return commaList(raw)
    .filter((group) => group.length <= TRUSTED_PROXY_MAX_GROUP_LENGTH)
    .slice(0, TRUSTED_PROXY_MAX_GROUPS);
}

/** Resolve the gateway user from request headers. Shared by both entry points. */
export function authenticateTrustedProxyHeaders(
  headers: Headers,
  config: TrustedProxyConfig,
): AuthOutcome {
  if (!trustedProxySecretMatches(headers.get(config.secretHeader), config.secret)) {
    return INVALID;
  }
  const user = headers.get(config.userHeader)?.trim();
  if (!user) {
    log.warn(`A gateway request carried no ${config.userHeader} header; refused.`);
    return INVALID;
  }
  if (user.includes(',')) {
    log.warn(`A gateway request carried more than one ${config.userHeader} value; refused.`);
    return INVALID;
  }
  const ownerId = `${OWNER_ID_PREFIX}${user}`;
  if (!isStorableOwnerId(ownerId)) {
    // The value itself is not logged: it is request data of unknown shape.
    log.warn(
      `A gateway user (${user.length} characters) is not a storable owner id: it must be ` +
        'printable ASCII without spaces and at most 250 characters; refused.',
    );
    return INVALID;
  }

  const roles = new Set<string>([OWNER_ROLES.coursePublish]);
  if (config.groupsHeader && config.adminGroups.size) {
    const groups = groupsFrom(headers.get(config.groupsHeader));
    if (groups.some((group) => config.adminGroups.has(group))) roles.add(OWNER_ROLES.admin);
  }
  const principal: OwnerPrincipal = {
    ownerId,
    kind: 'user',
    roles,
    assurance: 'verified',
    channel: 'proxy',
  };
  return { ok: true, principal };
}

/**
 * Create the `trustedProxyHeader` authenticator for a validated configuration
 * (see {@link resolveTrustedProxyConfig}). Route handlers and Server Actions
 * read the same headers with the same rules; neither sets a cookie.
 */
export function createTrustedProxyAuthenticator(config: TrustedProxyConfig): OwnerAuthenticator {
  return {
    name: 'trustedProxyHeader',
    authenticate: async (req) => authenticateTrustedProxyHeaders(req.headers, config),
    authenticateFromContext: async () => {
      const { headers } = await import('next/headers');
      return authenticateTrustedProxyHeaders(new Headers(await headers()), config);
    },
  };
}
