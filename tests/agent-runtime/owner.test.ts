import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOwnerRecoveryCode,
  resolveRequestOwnerId,
  restoreRequestOwnerId,
} from '@/lib/server/agent-runtime/owner';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveRequestOwnerId', () => {
  it('mints a UUID-backed anonymous owner when the cookie is absent', () => {
    const responseHeaders = new Headers();

    const ownerId = resolveRequestOwnerId(new Request('http://localhost/agent'), responseHeaders);

    expect(ownerId.startsWith('anon:')).toBe(true);
    expect(ownerId.slice('anon:'.length)).toMatch(UUID_V4);
    expect(responseHeaders.get('set-cookie')).toContain(
      `anonymous_id=${ownerId.slice('anon:'.length)}`,
    );
  });

  it('renews a valid anonymous cookie while retaining the original owner partition', () => {
    const id = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';
    const responseHeaders = new Headers();
    const request = new Request('http://localhost/agent', {
      headers: { cookie: `theme=dark; anonymous_id=${id}; locale=en` },
    });

    expect(resolveRequestOwnerId(request, responseHeaders)).toBe(`anon:${id}`);
    expect(responseHeaders.get('set-cookie')).toContain(`anonymous_id=${id};`);
    expect(responseHeaders.get('set-cookie')).toContain('Max-Age=31536000');
  });

  it('sets a long-lived, HTTP-only, SameSite=Lax cookie at the root path', () => {
    const responseHeaders = new Headers();

    resolveRequestOwnerId(new Request('http://localhost/agent'), responseHeaders);

    expect(responseHeaders.get('set-cookie')).toMatch(
      /^anonymous_id=[0-9a-f-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=31536000$/i,
    );
  });

  it.each(['development', 'production'])('adds Secure to HTTPS cookies in %s', (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    const responseHeaders = new Headers();

    resolveRequestOwnerId(new Request('https://example.test/agent'), responseHeaders);

    expect(responseHeaders.get('set-cookie')).toMatch(/; Secure$/);
  });

  it('keeps HTTP private-network cookies usable in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const responseHeaders = new Headers();

    resolveRequestOwnerId(
      new Request('http://192.168.1.50:3000/agent', {
        headers: { 'x-forwarded-proto': 'https' },
      }),
      responseHeaders,
    );

    expect(responseHeaders.get('set-cookie')).not.toContain('Secure');
  });

  it('does not let a forwarded header downgrade an HTTPS cookie', () => {
    const responseHeaders = new Headers();

    resolveRequestOwnerId(
      new Request('https://example.test/agent', { headers: { 'x-forwarded-proto': 'http' } }),
      responseHeaders,
    );

    expect(responseHeaders.get('set-cookie')).toMatch(/; Secure$/);
  });

  it.each(['development', 'production'])('supports a headers-only caller in %s', (environment) => {
    vi.stubEnv('NODE_ENV', environment);
    const responseHeaders = new Headers();

    resolveRequestOwnerId({ headers: new Headers() }, responseHeaders);

    expect(responseHeaders.get('set-cookie')?.includes('Secure')).toBe(
      environment === 'production',
    );
  });

  it.each(['not-a-uuid', '%broken', 'a652e716-0e2e-17f5-8432-4ee60f6f0977'])(
    'replaces the malformed anonymous cookie %s',
    (cookie) => {
      const responseHeaders = new Headers();
      const ownerId = resolveRequestOwnerId(
        new Request('http://localhost/agent', { headers: { cookie: `anonymous_id=${cookie}` } }),
        responseHeaders,
      );

      expect(ownerId.slice('anon:'.length)).toMatch(UUID_V4);
      expect(responseHeaders.get('set-cookie')).toContain(ownerId.slice('anon:'.length));
    },
  );

  it('uses an explicit authenticated owner without minting an anonymous cookie', () => {
    const responseHeaders = new Headers();

    const ownerId = resolveRequestOwnerId(
      new Request('http://localhost/agent'),
      responseHeaders,
      'user-42',
    );

    expect(ownerId).toBe('user-42');
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });

  it('prefers an authenticated owner over an existing anonymous cookie', () => {
    const responseHeaders = new Headers();
    const request = new Request('http://localhost/agent', {
      headers: { cookie: 'anonymous_id=a652e716-0e2e-47f5-8432-4ee60f6f0977' },
    });

    expect(resolveRequestOwnerId(request, responseHeaders, 'user-42')).toBe('user-42');
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });
});

describe('owner recovery', () => {
  const id = 'a652e716-0e2e-47f5-8432-4ee60f6f0977';

  it('restores the exact owner and cookie from a versioned recovery code', () => {
    const responseHeaders = new Headers();
    const recoveryCode = createOwnerRecoveryCode(`anon:${id}`);

    expect(recoveryCode).toBe(`openmaic-teacher-v1:${id}`);
    expect(
      restoreRequestOwnerId(new Request('http://localhost/teacher'), responseHeaders, recoveryCode),
    ).toBe(`anon:${id}`);
    expect(responseHeaders.get('set-cookie')).toContain(`anonymous_id=${id};`);
  });

  it('preserves the case of legacy cookie identifiers during recovery', () => {
    const responseHeaders = new Headers();
    const ownerId = `anon:${id.toUpperCase()}`;

    expect(
      restoreRequestOwnerId(
        new Request('https://example.test/teacher'),
        responseHeaders,
        createOwnerRecoveryCode(ownerId),
      ),
    ).toBe(ownerId);
    expect(responseHeaders.get('set-cookie')).toMatch(/; Secure$/);
  });

  it.each([
    undefined,
    null,
    {},
    123,
    id,
    `openmaic-teacher-v2:${id}`,
    `openmaic-teacher-v1:${id}\r\n`,
  ])('does not set a cookie for an invalid recovery code', (code) => {
    const responseHeaders = new Headers();

    expect(
      restoreRequestOwnerId(new Request('http://localhost/teacher'), responseHeaders, code),
    ).toBeNull();
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });

  it('does not issue recovery codes for authenticated owners', () => {
    expect(() => createOwnerRecoveryCode('user-42')).toThrow('Only anonymous owners');
  });
});
