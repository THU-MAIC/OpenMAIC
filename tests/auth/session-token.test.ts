import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_COOKIE_NAME,
  signSessionToken,
  verifySessionToken,
  type SessionClaims,
} from '@/lib/auth/session-token';

function claims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    v: 1,
    sid: 'session-id-1',
    uid: 'user-id-1',
    role: '3',
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe('session-token', () => {
  beforeEach(() => {
    vi.stubEnv('SESSION_SECRET', 'unit-test-secret');
    vi.stubEnv('EDUKU_APP_SECRET', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips a signed claim set', async () => {
    const token = await signSessionToken(claims());
    const verified = await verifySessionToken(token);
    expect(verified).not.toBeNull();
    expect(verified).toMatchObject({
      v: 1,
      sid: 'session-id-1',
      uid: 'user-id-1',
      role: '3',
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSessionToken(claims());
    vi.stubEnv('SESSION_SECRET', 'another-secret');
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('rejects tampered payload and signature', async () => {
    const token = await signSessionToken(claims());
    const [payload, signature] = token.split('.');

    // Flip a payload byte without re-signing.
    const flippedPayload = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A');
    expect(await verifySessionToken(`${flippedPayload}.${signature}`)).toBeNull();

    // Truncated signature.
    expect(await verifySessionToken(`${payload}.${signature.slice(0, -2)}`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signSessionToken(claims({ exp: Math.floor(Date.now() / 1000) - 60 }));
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifySessionToken('')).toBeNull();
    expect(await verifySessionToken('nodot')).toBeNull();
    expect(await verifySessionToken('.')).toBeNull();
    expect(await verifySessionToken('payload.')).toBeNull();
    expect(await verifySessionToken('not-base64!!.not-base64!!')).toBeNull();
  });

  it('rejects payloads missing required claim fields', async () => {
    // A validly signed payload whose shape is wrong (built via the internal
    // shape by signing a modified object through the public API is impossible,
    // so simulate by signing claims and stripping a field at verify time is
    // not reachable; instead verify the field validation rejects a payload
    // with a wrong version).
    const token = await signSessionToken(claims({ v: 2 as unknown as 1 }));
    expect(await verifySessionToken(token)).toBeNull();
  });

  it('exposes the cookie name used by middleware and routes', () => {
    expect(SESSION_COOKIE_NAME).toBe('openmaic_session');
  });
});
