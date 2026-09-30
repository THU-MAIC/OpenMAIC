import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { middleware } from '@/proxy';
import {
  configureOwnerAuthentication,
  OWNER_ROLES,
  principalFromStoredOwner,
  sharedTeamAuthMethod,
  singleUserAuthMethod,
} from '@/lib/server/identity';
import {
  resetOwnerAuthenticationForTests,
  validateOwnerIdentityConfiguration,
  warnAboutOwnerIdentityConfiguration,
} from '@/lib/server/identity/registry';
import { resolveRequestOwner } from '@/lib/server/identity/resolve';
import {
  resetSingleUserWarningForTests,
  resolveSingleUserOwnerId,
} from '@/lib/server/identity/single-user';
import type { OwnerAuthMethod } from '@/lib/server/identity/types';
import { isLoopbackAddress } from '@/lib/server/publish-address';

const CODE = 'demo-code-that-is-long-enough';
const ANON_UUID = '7e2d1b3c-4a5f-4b6e-8c7d-9e0f1a2b3c4d';

const ENV_KEYS = [
  'ACCESS_CODE',
  'OWNER_SINGLE_USER',
  'OWNER_SINGLE_USER_ID',
  'OPENMAIC_PUBLISH_ADDRESS',
  'PERSISTENCE_SHARED_OWNER_ID',
] as const;

interface Setup {
  enabled?: string;
  id?: string;
  accessCode?: string;
  publishAddress?: string;
  sharedOwnerId?: string;
}

/** Set exactly these variables; every other one of {@link ENV_KEYS} is blank. */
function configure(setup: Setup): void {
  const values: Record<(typeof ENV_KEYS)[number], string | undefined> = {
    ACCESS_CODE: setup.accessCode,
    OWNER_SINGLE_USER: setup.enabled,
    OWNER_SINGLE_USER_ID: setup.id,
    OPENMAIC_PUBLISH_ADDRESS: setup.publishAddress,
    PERSISTENCE_SHARED_OWNER_ID: setup.sharedOwnerId,
  };
  for (const key of ENV_KEYS) vi.stubEnv(key, values[key] ?? '');
}

const notApplicable: OwnerAuthMethod = {
  name: 'host',
  authenticate: async () => ({ status: 'not-applicable' }),
};

beforeEach(() => configure({}));

afterEach(() => {
  vi.unstubAllEnvs();
  resetOwnerAuthenticationForTests();
});

describe('resolveSingleUserOwnerId', () => {
  it('is off when the switch is unset, blank, "false" or "0"', () => {
    for (const enabled of [undefined, '', '  ', 'false', '0', 'FALSE']) {
      configure({ enabled, accessCode: CODE });
      expect(resolveSingleUserOwnerId(), String(enabled)).toBeUndefined();
    }
  });

  it('is on for "true" and "1", with the default owner id', () => {
    for (const enabled of ['true', '1', 'TRUE', ' true ']) {
      configure({ enabled, accessCode: CODE });
      expect(resolveSingleUserOwnerId(), enabled).toBe('local');
    }
  });

  it('refuses a switch value that is not a boolean', () => {
    configure({ enabled: 'yes', accessCode: CODE });
    expect(() => resolveSingleUserOwnerId()).toThrow(/OWNER_SINGLE_USER must be/);
  });

  it('uses OWNER_SINGLE_USER_ID, trimmed, and validates it like the shared owner id', () => {
    configure({ enabled: 'true', accessCode: CODE, id: '  alice_1.home-lab  ' });
    expect(resolveSingleUserOwnerId()).toBe('alice_1.home-lab');

    for (const id of [`anon:${ANON_UUID}`, 'has space', 'slash/y', 'a'.repeat(129)]) {
      configure({ enabled: 'true', accessCode: CODE, id });
      expect(() => resolveSingleUserOwnerId(), id).toThrow(/OWNER_SINGLE_USER_ID must be/);
    }
  });

  it('refuses OWNER_SINGLE_USER_ID while the mode is off: it would be ignored', () => {
    configure({ id: 'alice', accessCode: CODE });
    expect(() => resolveSingleUserOwnerId()).toThrow(/OWNER_SINGLE_USER_ID is set/);
  });
});

describe('exposure: lenient, warned', () => {
  let warn: MockInstance<(...args: unknown[]) => void>;
  const warned = () =>
    warn.mock.calls.filter((args: unknown[]) => args.join(' ').includes('Single-user mode')).length;

  beforeEach(() => {
    resetSingleUserWarningForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) as MockInstance<
      (...args: unknown[]) => void
    >;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs without ACCESS_CODE, whatever the published address', () => {
    for (const publishAddress of [undefined, '127.0.0.1', '0.0.0.0', '192.168.1.20']) {
      configure({ enabled: 'true', publishAddress });
      expect(resolveSingleUserOwnerId(), String(publishAddress)).toBe('local');
      expect(validateOwnerIdentityConfiguration()).toBe('singleUser');
    }
  });

  it('warns exactly once when single-user mode is on and ACCESS_CODE is unset', () => {
    configure({ enabled: 'true' });
    warnAboutOwnerIdentityConfiguration();
    warnAboutOwnerIdentityConfiguration();
    expect(warned()).toBe(1);
    const text = warn.mock.calls.flat().join(' ');
    expect(text).toMatch(/ACCESS_CODE is not set/);
    expect(text).toMatch(/share, edit[\s\S]*delete/);
  });

  it('does not warn behind ACCESS_CODE, or with the mode off', () => {
    configure({ enabled: 'true', accessCode: CODE });
    warnAboutOwnerIdentityConfiguration();
    configure({});
    warnAboutOwnerIdentityConfiguration();
    configure({ sharedOwnerId: 'team-alpha', accessCode: CODE });
    warnAboutOwnerIdentityConfiguration();
    expect(warned()).toBe(0);
  });

  it('warns for a host registration that includes singleUser, not for one without it', () => {
    configure({ enabled: 'true' });
    configureOwnerAuthentication({ methods: [notApplicable, singleUserAuthMethod()] });
    warnAboutOwnerIdentityConfiguration();
    expect(warned()).toBe(1);
  });

  it('classifies loopback addresses strictly', () => {
    expect(isLoopbackAddress('127.255.255.254')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(true);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('127.0.0.256')).toBe(false);
    expect(isLoopbackAddress('127.0.0.1.example.test')).toBe(false);
    expect(isLoopbackAddress('1127.0.0.1')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });

  it('keeps an unauthenticated request away when ACCESS_CODE is set', async () => {
    configure({ enabled: 'true', accessCode: CODE, publishAddress: '0.0.0.0' });
    const refused = await middleware(new NextRequest('http://localhost/api/stages'));
    expect(refused.status).toBe(401);

    const raw = String(Date.now());
    const token = `${raw}.${createHmac('sha256', CODE).update(raw).digest('hex')}`;
    const admitted = new NextRequest('http://localhost/api/stages', {
      headers: { cookie: `openmaic_access=${token}` },
    });
    expect((await middleware(admitted)).status).toBe(200);
    await expect(resolveRequestOwner(admitted)).resolves.toMatchObject({
      ok: true,
      principal: { ownerId: 'local' },
    });
  });
});

describe('the singleUser built-in through the seam', () => {
  it('resolves every request to the single owner, holding course:publish, minting nothing', async () => {
    configure({ enabled: 'true' });

    const outcome = await resolveRequestOwner(new Request('http://localhost/api/stages'));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.principal).toMatchObject({
      ownerId: 'local',
      kind: 'user',
      assurance: 'unverified-legacy',
    });
    expect(outcome.principal.roles.has(OWNER_ROLES.coursePublish)).toBe(true);
    expect(outcome.principal.roles.has(OWNER_ROLES.admin)).toBe(false);
    expect(outcome.principal.pendingClaim).toBeUndefined();
    expect(outcome.setCookies).toBeUndefined();
  });

  it('attaches the anonymous cookie presented beside it as a claim candidate', async () => {
    configure({ enabled: 'true' });

    const outcome = await resolveRequestOwner(
      new Request('http://localhost/api/stages', {
        headers: { cookie: `anonymous_id=${ANON_UUID}` },
      }),
    );

    expect(outcome).toMatchObject({
      ok: true,
      principal: {
        ownerId: 'local',
        pendingClaim: { fromOwnerId: `anon:${ANON_UUID}`, assurance: 'unverified-legacy' },
      },
    });
  });

  it('describes its stored owner as a publishing user, and leaves anonymous ids anonymous', () => {
    configure({ enabled: 'true', id: 'alice' });

    const stored = principalFromStoredOwner('alice');
    expect(stored.kind).toBe('user');
    expect(stored.roles.has(OWNER_ROLES.coursePublish)).toBe(true);
    expect(principalFromStoredOwner(`anon:${ANON_UUID}`).kind).toBe('anonymous');
    expect(principalFromStoredOwner('someone-else').roles.size).toBe(0);
  });

  it('fails owner resolution, not falls back to the cookie, when misconfigured', async () => {
    configure({ enabled: 'yes' });

    await expect(resolveRequestOwner(new Request('http://localhost/api/stages'))).rejects.toThrow(
      /OWNER_SINGLE_USER must be/,
    );
  });
});

describe('boot validation and interplay', () => {
  it('reports the mode', () => {
    expect(validateOwnerIdentityConfiguration()).toBe('anonymousCookie');
    configure({ enabled: 'true' });
    expect(validateOwnerIdentityConfiguration()).toBe('singleUser');
  });

  it('refuses single-user mode beside PERSISTENCE_SHARED_OWNER_ID, at boot and per request', async () => {
    configure({ enabled: 'true', accessCode: CODE, sharedOwnerId: 'team-alpha' });
    expect(() => validateOwnerIdentityConfiguration()).toThrow(
      /PERSISTENCE_SHARED_OWNER_ID and OWNER_SINGLE_USER=true are both set/,
    );
    await expect(resolveRequestOwner(new Request('http://localhost/x'))).rejects.toThrow(
      /both set/,
    );
  });

  it('refuses the switch beside a host registration that leaves singleUser out', () => {
    configureOwnerAuthentication({ methods: [notApplicable] });
    configure({ enabled: 'true' });
    expect(() => validateOwnerIdentityConfiguration()).toThrow(/do not include singleUser/);
  });

  it('refuses a registered singleUser without its switch, or not last', () => {
    expect(() => configureOwnerAuthentication({ methods: [singleUserAuthMethod()] })).toThrow(
      /singleUserAuthMethod\(\) is registered but OWNER_SINGLE_USER is not "true"/,
    );
    configure({ enabled: 'true' });
    expect(() =>
      configureOwnerAuthentication({ methods: [singleUserAuthMethod(), notApplicable] }),
    ).toThrow(/must be the last owner auth method/);
  });

  it('refuses both catch-all built-ins in one registration', () => {
    configure({ enabled: 'true', accessCode: CODE, sharedOwnerId: 'team-alpha' });
    expect(() =>
      configureOwnerAuthentication({ methods: [sharedTeamAuthMethod(), singleUserAuthMethod()] }),
    ).toThrow(/both set/);
  });

  it('asks singleUser after the host methods when the host includes it', async () => {
    configure({ enabled: 'true' });
    const header: OwnerAuthMethod = {
      name: 'header',
      authenticate: async (req) =>
        req.headers.get('x-user')
          ? {
              status: 'authenticated',
              principal: {
                ownerId: `user:${req.headers.get('x-user')}`,
                kind: 'user',
                roles: new Set(),
                assurance: 'verified',
              },
            }
          : { status: 'not-applicable' },
    };
    configureOwnerAuthentication({ methods: [header, singleUserAuthMethod()] });
    expect(validateOwnerIdentityConfiguration()).toBe('configured');

    await expect(
      resolveRequestOwner(new Request('http://localhost/x', { headers: { 'x-user': 'bob' } })),
    ).resolves.toMatchObject({ principal: { ownerId: 'user:bob' } });
    await expect(resolveRequestOwner(new Request('http://localhost/x'))).resolves.toMatchObject({
      principal: { ownerId: 'local' },
    });
  });
});
