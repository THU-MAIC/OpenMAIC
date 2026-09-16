import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { createAccessToken } from '@/lib/server/access-token';
import { sharedOwnerId } from '@/lib/server/agent-runtime/shared-owner';

afterEach(() => {
  vi.unstubAllEnvs();
});

const req = (cookie?: string) =>
  new Request('http://localhost/api/stages', cookie ? { headers: { cookie } } : undefined);

describe('shared owner (PERSISTENCE_SHARED_OWNER_ID)', () => {
  it('is off when the env is unset or blank: upstream anonymous cookie behaviour', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    const headers = new Headers();
    expect(sharedOwnerId(req())).toBeUndefined();
    expect(resolveRequestOwnerId(req(), headers).startsWith('anon:')).toBe(true);
    expect(headers.has('set-cookie')).toBe(true);
  });

  it('applies unconditionally when there is no access-code gate, without minting a cookie', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'matnastik');
    vi.stubEnv('ACCESS_CODE', '');
    const headers = new Headers();
    expect(resolveRequestOwnerId(req(), headers)).toBe('matnastik');
    expect(headers.has('set-cookie')).toBe(false);
  });

  it('applies only to requests carrying a valid access token when ACCESS_CODE is set', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'matnastik');
    vi.stubEnv('ACCESS_CODE', 'kelime dizisi en az yirmi karakter');
    const token = createAccessToken('kelime dizisi en az yirmi karakter');
    const headers = new Headers();
    expect(resolveRequestOwnerId(req(`theme=dark; openmaic_access=${token}`), headers)).toBe(
      'matnastik',
    );
    expect(headers.has('set-cookie')).toBe(false);
  });

  it('falls back to the anonymous path for a missing or forged access token', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'matnastik');
    vi.stubEnv('ACCESS_CODE', 'kelime dizisi en az yirmi karakter');
    expect(resolveRequestOwnerId(req(), new Headers()).startsWith('anon:')).toBe(true);
    const forged = createAccessToken('baska kod');
    expect(
      resolveRequestOwnerId(req(`openmaic_access=${forged}`), new Headers()).startsWith('anon:'),
    ).toBe(true);
  });

  it('refuses an id in the anon: namespace and lets a host authenticated id win', () => {
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'anon:not-allowed');
    vi.stubEnv('ACCESS_CODE', '');
    expect(sharedOwnerId(req())).toBeUndefined();
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', 'matnastik');
    expect(resolveRequestOwnerId(req(), new Headers(), 'user:42')).toBe('user:42');
  });
});
