import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestHeaders: new Headers(),
  cookieSet: vi.fn(),
  softDeleteSession: vi.fn(async () => true),
}));
vi.mock('next/headers', () => ({
  headers: async () => mocks.requestHeaders,
  cookies: async () => ({ get: () => undefined, set: mocks.cookieSet }),
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({ softDeleteSession: mocks.softDeleteSession }),
}));

import { configureOwnerAuthenticator, OWNER_ROLES } from '@/lib/server/identity';
import {
  getOwnerAuthenticator,
  resetOwnerAuthenticatorForTests,
  validateOwnerIdentityConfiguration,
} from '@/lib/server/identity/registry';
import {
  InvalidOwnerCredentialError,
  requireContextOwner,
  resolveRequestOwner,
} from '@/lib/server/identity/resolve';
import {
  resolveTrustedProxyConfig,
  TRUSTED_PROXY_MAX_GROUPS,
  trustedProxySecretMatches,
} from '@/lib/server/identity/trusted-proxy';
import type { AuthOutcome, OwnerPrincipal } from '@/lib/server/identity/types';
import { deleteWorkspaceSession } from '@/lib/workbench/workspace-actions';

const SECRET = 's'.repeat(24) + '-gateway-secret-0123456789';
const OTHER_TRUSTED_PROXY_VARS = [
  'TRUSTED_PROXY_SECRET_HEADER',
  'TRUSTED_PROXY_USER_HEADER',
  'TRUSTED_PROXY_GROUPS_HEADER',
  'TRUSTED_PROXY_ADMIN_GROUPS',
];

/** Turn the built-in on the way a deployment would. */
function enable(extra: Record<string, string> = {}): void {
  vi.stubEnv('OWNER_AUTHENTICATOR', 'trusted-proxy');
  vi.stubEnv('TRUSTED_PROXY_SECRET', SECRET);
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
}

function gatewayRequest(headers: Record<string, string> | Headers): Request {
  return new Request('http://localhost/api/stages', { headers });
}

async function principalFor(headers: Record<string, string> | Headers): Promise<OwnerPrincipal> {
  const outcome = await resolveRequestOwner(gatewayRequest(headers));
  if (!outcome.ok) throw new Error('expected an authenticated principal');
  return outcome.principal;
}

async function outcomeFor(headers: Record<string, string> | Headers): Promise<AuthOutcome> {
  return resolveRequestOwner(gatewayRequest(headers));
}

const INVALID = { ok: false, status: 401, code: 'INVALID_CREDENTIAL' };

beforeEach(() => {
  vi.unstubAllEnvs();
  // Start from a clean slate whatever the shell exports.
  vi.stubEnv('OWNER_AUTHENTICATOR', '');
  vi.stubEnv('TRUSTED_PROXY_SECRET', '');
  for (const name of OTHER_TRUSTED_PROXY_VARS) vi.stubEnv(name, '');
  vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
  mocks.requestHeaders = new Headers();
  mocks.cookieSet.mockClear();
  mocks.softDeleteSession.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetOwnerAuthenticatorForTests();
});

describe('trusted-proxy configuration', () => {
  it('is off by default and when every variable is blank', () => {
    expect(resolveTrustedProxyConfig()).toBeUndefined();
    expect(validateOwnerIdentityConfiguration()).toBe('anonymousCookie');
    vi.stubEnv('OWNER_AUTHENTICATOR', '   ');
    expect(resolveTrustedProxyConfig()).toBeUndefined();
  });

  it('uses the documented defaults', () => {
    enable();
    expect(resolveTrustedProxyConfig()).toEqual({
      secret: SECRET,
      secretHeader: 'x-openmaic-proxy-secret',
      userHeader: 'x-forwarded-user',
      groupsHeader: undefined,
      adminGroups: new Set(),
    });
    expect(validateOwnerIdentityConfiguration()).toBe('trustedProxyHeader');
    expect(getOwnerAuthenticator().name).toBe('default');
  });

  it('lower-cases configured header names and splits admin groups', () => {
    enable({
      TRUSTED_PROXY_SECRET_HEADER: ' X-Gateway-Secret ',
      TRUSTED_PROXY_USER_HEADER: 'X-Auth-Request-User',
      TRUSTED_PROXY_GROUPS_HEADER: 'X-Auth-Request-Groups',
      TRUSTED_PROXY_ADMIN_GROUPS: ' ops , , platform-admins ',
    });
    expect(resolveTrustedProxyConfig()).toEqual({
      secret: SECRET,
      secretHeader: 'x-gateway-secret',
      userHeader: 'x-auth-request-user',
      groupsHeader: 'x-auth-request-groups',
      adminGroups: new Set(['ops', 'platform-admins']),
    });
  });

  it.each<[string, Record<string, string>, RegExp]>([
    ['an unknown selector', { OWNER_AUTHENTICATOR: 'trusted_proxy' }, /must be "trusted-proxy"/],
    [
      'a trusted-proxy variable without the selector',
      { OWNER_AUTHENTICATOR: '', TRUSTED_PROXY_SECRET: '', TRUSTED_PROXY_USER_HEADER: 'x-user' },
      /TRUSTED_PROXY_USER_HEADER is set but OWNER_AUTHENTICATOR/,
    ],
    [
      'the secret without the selector',
      { OWNER_AUTHENTICATOR: '', TRUSTED_PROXY_SECRET: SECRET },
      /TRUSTED_PROXY_SECRET is set but OWNER_AUTHENTICATOR/,
    ],
    [
      'the shared owner id as well',
      { PERSISTENCE_SHARED_OWNER_ID: 'team-alpha', ACCESS_CODE: 'demo-code-that-is-long-enough' },
      /two different owner authenticators/,
    ],
    ['no secret', { TRUSTED_PROXY_SECRET: '' }, /requires TRUSTED_PROXY_SECRET/],
    ['a blank secret', { TRUSTED_PROXY_SECRET: '    ' }, /requires TRUSTED_PROXY_SECRET/],
    ['a short secret', { TRUSTED_PROXY_SECRET: 'x'.repeat(31) }, /32-1024 printable/],
    ['an over-long secret', { TRUSTED_PROXY_SECRET: 'x'.repeat(1025) }, /32-1024 printable/],
    ['a secret with a space', { TRUSTED_PROXY_SECRET: `${SECRET} tail` }, /without spaces/],
    ['a padded secret', { TRUSTED_PROXY_SECRET: ` ${SECRET}` }, /without spaces/],
    ['a non-ASCII secret', { TRUSTED_PROXY_SECRET: `${SECRET}é` }, /printable ASCII/],
    [
      'a malformed user header name',
      { TRUSTED_PROXY_USER_HEADER: 'x forwarded user' },
      /TRUSTED_PROXY_USER_HEADER must be an HTTP header name/,
    ],
    [
      'a reserved secret header name',
      { TRUSTED_PROXY_SECRET_HEADER: 'Cookie' },
      /TRUSTED_PROXY_SECRET_HEADER names "cookie", a header that HTTP, Next.js/,
    ],
    [
      'a reserved groups header name',
      { TRUSTED_PROXY_GROUPS_HEADER: 'authorization' },
      /TRUSTED_PROXY_GROUPS_HEADER names "authorization"/,
    ],
    [
      'the user header doubling as the secret header',
      { TRUSTED_PROXY_SECRET_HEADER: 'X-Forwarded-User' },
      /must name different headers/,
    ],
    [
      'the groups header doubling as the user header',
      { TRUSTED_PROXY_GROUPS_HEADER: 'x-forwarded-user' },
      /must name different headers/,
    ],
    [
      'admin groups without a groups header',
      { TRUSTED_PROXY_ADMIN_GROUPS: 'ops' },
      /TRUSTED_PROXY_ADMIN_GROUPS requires TRUSTED_PROXY_GROUPS_HEADER/,
    ],
    [
      'admin groups that list no group',
      { TRUSTED_PROXY_GROUPS_HEADER: 'x-forwarded-groups', TRUSTED_PROXY_ADMIN_GROUPS: ' , ' },
      /must list at least one group/,
    ],
  ])('refuses %s at boot', (_label, extra, message) => {
    enable(extra);
    expect(() => validateOwnerIdentityConfiguration()).toThrow(message);
  });

  it('refuses to combine the selector with a host-registered authenticator', () => {
    enable();
    expect(() =>
      configureOwnerAuthenticator({
        name: 'host',
        authenticate: async () => ({ ok: false, status: 401, code: 'INVALID_CREDENTIAL' }),
      }),
    ).toThrow(/OWNER_AUTHENTICATOR selects a built-in authenticator/);
  });

  it('refuses the selector when it appears after a host authenticator was registered', () => {
    configureOwnerAuthenticator({
      name: 'host',
      authenticate: async () => ({ ok: false, status: 401, code: 'INVALID_CREDENTIAL' }),
    });
    enable();
    expect(() => validateOwnerIdentityConfiguration()).toThrow(
      /cannot be combined with a configured authenticator \(host\)/,
    );
  });
});

describe('reserved header names', () => {
  const RESERVED = [
    // Next.js internal families, reserved by prefix.
    'x-middleware-subrequest',
    'X-Middleware-Rewrite',
    'x-invoke-path',
    'x-nextjs-data',
    'next-router-state-tree',
    'next-router-prefetch',
    'rsc',
    'next-action',
    // Forwarding headers a proxy sets from the connection or passes through.
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-forwarded-port',
    'x-real-ip',
    'forwarded',
  ];
  const VARIABLES = [
    'TRUSTED_PROXY_USER_HEADER',
    'TRUSTED_PROXY_GROUPS_HEADER',
    'TRUSTED_PROXY_SECRET_HEADER',
  ];

  it.each(VARIABLES.flatMap((variable) => RESERVED.map((name) => [variable, name])))(
    'refuses %s=%s at boot',
    (variable, name) => {
      enable({ [variable]: name });
      expect(() => validateOwnerIdentityConfiguration()).toThrow(
        new RegExp(`${variable} names "${name.toLowerCase()}", a header that HTTP, Next.js`),
      );
    },
  );

  it.each(['x-forwarded-user', 'x-forwarded-email', 'x-nextjs', 'x-invoker', 'rsc-user'])(
    'still accepts the neighbouring name %s',
    (name) => {
      enable({ TRUSTED_PROXY_USER_HEADER: name });
      expect(resolveTrustedProxyConfig()?.userHeader).toBe(name);
    },
  );
});

describe('the admin groups boot warning', () => {
  const warnings = () =>
    vi
      .mocked(console.warn)
      .mock.calls.flat()
      .filter((line) => String(line).includes('TRUSTED_PROXY_ADMIN_GROUPS'));

  it('is logged once when admin groups are configured', () => {
    enable({
      TRUSTED_PROXY_GROUPS_HEADER: 'x-forwarded-groups',
      TRUSTED_PROXY_ADMIN_GROUPS: 'ops',
    });
    validateOwnerIdentityConfiguration();
    validateOwnerIdentityConfiguration();
    expect(warnings()).toHaveLength(1);
    expect(String(warnings()[0])).toMatch(
      /WARNING: .*x-forwarded-groups header, which is trusted on the strength of the shared secret alone\. The gateway MUST overwrite or strip/,
    );
  });

  it('is not logged without admin groups', () => {
    enable({ TRUSTED_PROXY_GROUPS_HEADER: 'x-forwarded-groups' });
    validateOwnerIdentityConfiguration();
    expect(warnings()).toHaveLength(0);
  });
});

describe('the gateway secret', () => {
  it('matches only the exact value', () => {
    expect(trustedProxySecretMatches(SECRET, SECRET)).toBe(true);
    expect(trustedProxySecretMatches(null, SECRET)).toBe(false);
    expect(trustedProxySecretMatches('', SECRET)).toBe(false);
    expect(trustedProxySecretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(trustedProxySecretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(trustedProxySecretMatches(SECRET.toUpperCase(), SECRET)).toBe(false);
    expect(trustedProxySecretMatches(`${SECRET}, ${SECRET}`, SECRET)).toBe(false);
  });

  it.each<[string, Record<string, string>]>([
    ['missing', { 'x-forwarded-user': 'alice' }],
    ['empty', { 'x-openmaic-proxy-secret': '', 'x-forwarded-user': 'alice' }],
    ['wrong', { 'x-openmaic-proxy-secret': 'w'.repeat(40), 'x-forwarded-user': 'alice' }],
    ['a prefix', { 'x-openmaic-proxy-secret': SECRET.slice(0, 32), 'x-forwarded-user': 'alice' }],
    ['longer', { 'x-openmaic-proxy-secret': `${SECRET}0`, 'x-forwarded-user': 'alice' }],
    ['in a different header', { 'x-other-secret': SECRET, 'x-forwarded-user': 'alice' }],
  ])('refuses a request whose secret is %s with 401', async (_label, headers) => {
    enable();
    await expect(outcomeFor(headers)).resolves.toEqual(INVALID);
  });

  it('refuses a secret sent twice', async () => {
    enable();
    const headers = new Headers({ 'x-forwarded-user': 'alice' });
    headers.append('x-openmaic-proxy-secret', SECRET);
    headers.append('x-openmaic-proxy-secret', SECRET);
    await expect(outcomeFor(headers)).resolves.toEqual(INVALID);
  });

  it('reads the secret from the configured header', async () => {
    enable({ TRUSTED_PROXY_SECRET_HEADER: 'x-gateway-secret' });
    await expect(
      outcomeFor({ 'x-openmaic-proxy-secret': SECRET, 'x-forwarded-user': 'alice' }),
    ).resolves.toEqual(INVALID);
    await expect(
      principalFor({ 'x-gateway-secret': SECRET, 'x-forwarded-user': 'alice' }),
    ).resolves.toMatchObject({ ownerId: 'proxy:alice' });
  });
});

describe('the gateway user', () => {
  const withSecret = (headers: Record<string, string>) => ({
    'x-openmaic-proxy-secret': SECRET,
    ...headers,
  });

  it('becomes a verified, publishing user principal without a cookie', async () => {
    enable();
    const outcome = await outcomeFor(withSecret({ 'x-forwarded-user': 'alice' }));
    expect(outcome).toEqual({
      ok: true,
      principal: {
        ownerId: 'proxy:alice',
        kind: 'user',
        roles: new Set([OWNER_ROLES.coursePublish]),
        assurance: 'verified',
        channel: 'proxy',
      },
    });
  });

  it('is trimmed but keeps its case', async () => {
    enable();
    await expect(
      principalFor(withSecret({ 'x-forwarded-user': '  Alice@Example.org ' })),
    ).resolves.toMatchObject({ ownerId: 'proxy:Alice@Example.org' });
  });

  it.each<[string, Record<string, string>]>([
    ['missing', {}],
    ['empty', { 'x-forwarded-user': '' }],
    ['blank', { 'x-forwarded-user': '   ' }],
    ['comma-joined', { 'x-forwarded-user': 'alice,bob' }],
    ['a lone comma', { 'x-forwarded-user': ',' }],
    ['containing a space', { 'x-forwarded-user': 'alice smith' }],
    ['non-ASCII', { 'x-forwarded-user': 'zoë' }],
    ['too long for an owner id', { 'x-forwarded-user': 'u'.repeat(251) }],
  ])('is refused with 401 when %s', async (_label, headers) => {
    enable();
    await expect(outcomeFor(withSecret(headers))).resolves.toEqual(INVALID);
  });

  it('accepts the longest user that still fits an owner id', async () => {
    enable();
    const principal = await principalFor(withSecret({ 'x-forwarded-user': 'u'.repeat(250) }));
    expect(principal.ownerId).toHaveLength(256);
  });

  it('is refused when the header arrives twice', async () => {
    enable();
    const headers = new Headers({ 'x-openmaic-proxy-secret': SECRET });
    headers.append('x-forwarded-user', 'alice');
    headers.append('x-forwarded-user', 'bob');
    await expect(outcomeFor(headers)).resolves.toEqual(INVALID);
    // Even the same user twice is ambiguous at the header level.
    const same = new Headers({ 'x-openmaic-proxy-secret': SECRET });
    same.append('x-forwarded-user', 'alice');
    same.append('x-forwarded-user', 'alice');
    await expect(outcomeFor(same)).resolves.toEqual(INVALID);
  });

  it('comes from the configured user header only', async () => {
    enable({ TRUSTED_PROXY_USER_HEADER: 'x-auth-request-user' });
    await expect(outcomeFor(withSecret({ 'x-forwarded-user': 'alice' }))).resolves.toEqual(INVALID);
    await expect(
      principalFor(withSecret({ 'x-auth-request-user': 'alice' })),
    ).resolves.toMatchObject({ ownerId: 'proxy:alice' });
  });
});

describe('groups and the admin role', () => {
  const adminConfig = {
    TRUSTED_PROXY_GROUPS_HEADER: 'x-forwarded-groups',
    TRUSTED_PROXY_ADMIN_GROUPS: 'ops,platform-admins',
  };
  const request = (groups?: string) => ({
    'x-openmaic-proxy-secret': SECRET,
    'x-forwarded-user': 'alice',
    ...(groups === undefined ? {} : { 'x-forwarded-groups': groups }),
  });
  const roles = async (groups?: string) => [...(await principalFor(request(groups))).roles].sort();

  it('grants admin to a member of an admin group', async () => {
    enable(adminConfig);
    expect(await roles('staff, platform-admins')).toEqual([OWNER_ROLES.admin, 'course:publish']);
    expect(await roles(' ops ')).toEqual([OWNER_ROLES.admin, 'course:publish']);
  });

  it('grants only course:publish otherwise', async () => {
    enable(adminConfig);
    expect(await roles()).toEqual(['course:publish']);
    expect(await roles('')).toEqual(['course:publish']);
    expect(await roles('staff,,students')).toEqual(['course:publish']);
    // Group names compare exactly: an IdP may treat them as case-sensitive.
    expect(await roles('OPS')).toEqual(['course:publish']);
    expect(await roles('ops-readonly')).toEqual(['course:publish']);
  });

  it('merges duplicate groups header lines', async () => {
    enable(adminConfig);
    const headers = new Headers({ 'x-openmaic-proxy-secret': SECRET, 'x-forwarded-user': 'a' });
    headers.append('x-forwarded-groups', 'staff');
    headers.append('x-forwarded-groups', 'ops');
    expect([...(await principalFor(headers)).roles].sort()).toEqual(['admin', 'course:publish']);
  });

  it('ignores groups past the count and length caps', async () => {
    enable(adminConfig);
    const filler = Array.from({ length: TRUSTED_PROXY_MAX_GROUPS }, (_, i) => `g${i}`);
    expect(await roles([...filler, 'ops'].join(','))).toEqual(['course:publish']);
    enable({ ...adminConfig, TRUSTED_PROXY_ADMIN_GROUPS: `ops,${'a'.repeat(257)}` });
    expect(await roles('a'.repeat(257))).toEqual(['course:publish']);
  });

  it('never grants admin without admin groups configured', async () => {
    enable({ TRUSTED_PROXY_GROUPS_HEADER: 'x-forwarded-groups' });
    expect(await roles('ops,admin')).toEqual(['course:publish']);
  });
});

describe('resolution', () => {
  it('is memoized per request', async () => {
    enable();
    const req = gatewayRequest({ 'x-openmaic-proxy-secret': SECRET, 'x-forwarded-user': 'alice' });
    const get = vi.spyOn(req.headers, 'get');
    const first = resolveRequestOwner(req);
    const second = resolveRequestOwner(req);
    expect(second).toBe(first);
    await first;
    const reads = get.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await resolveRequestOwner(req);
    expect(get.mock.calls.length).toBe(reads);
  });

  it('gives a Server Action the same owner as a route, and writes no cookie', async () => {
    enable();
    mocks.requestHeaders = new Headers({
      'x-openmaic-proxy-secret': SECRET,
      'x-forwarded-user': 'carol',
    });

    await expect(requireContextOwner()).resolves.toMatchObject({
      ownerId: 'proxy:carol',
      kind: 'user',
      assurance: 'verified',
    });
    await expect(deleteWorkspaceSession('session-1')).resolves.toEqual({ deleted: true });
    expect(mocks.softDeleteSession).toHaveBeenCalledWith('session-1', 'proxy:carol');
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>]>([
    ['no secret', { 'x-forwarded-user': 'carol' }],
    ['a wrong secret', { 'x-openmaic-proxy-secret': 'w'.repeat(40), 'x-forwarded-user': 'carol' }],
    ['no user', { 'x-openmaic-proxy-secret': SECRET }],
    ['two users', { 'x-openmaic-proxy-secret': SECRET, 'x-forwarded-user': 'carol, dave' }],
  ])('refuses a Server Action with %s instead of acting anonymously', async (_label, headers) => {
    enable();
    mocks.requestHeaders = new Headers({ ...headers, cookie: 'anonymous_id=x' });

    await expect(requireContextOwner()).rejects.toBeInstanceOf(InvalidOwnerCredentialError);
    await expect(deleteWorkspaceSession('session-1')).rejects.toBeInstanceOf(
      InvalidOwnerCredentialError,
    );
    expect(mocks.softDeleteSession).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
