import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { middleware } from '@/middleware';
import { resolveRequestOwnerId } from '@/lib/server/agent-runtime/owner';
import { resolveSharedOwnerId } from '@/lib/server/agent-runtime/shared-owner';

const CODE = 'demo-code-that-is-long-enough';

/** Sign `timestamp` exactly the way the app mints access tokens. */
function tokenFor(timestamp: number): string {
  const raw = String(timestamp);
  return `${raw}.${createHmac('sha256', CODE).update(raw).digest('hex')}`;
}

/** An owner-scoped API request carrying (or not) the access cookie. */
function stageRequest(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue !== undefined) headers.set('cookie', `openmaic_access=${cookieValue}`);
  return new NextRequest('http://localhost/api/stages/abc', { method: 'GET', headers });
}

/**
 * Configure the feature the way a deployment would. Pass `null` for the access
 * code to leave it genuinely unset — `undefined` would not do, since a default
 * parameter swallows it, and deleting the variable afterwards clears the whole
 * stub registry, so the delete has to come first.
 */
function configure(sharedOwnerId: string, accessCode: string | null = CODE): void {
  if (accessCode === null) {
    delete process.env.ACCESS_CODE;
  } else {
    vi.stubEnv('ACCESS_CODE', accessCode);
  }
  vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', sharedOwnerId);
}

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.ACCESS_CODE;
});

describe('resolveSharedOwnerId', () => {
  it('is unset when the variable is absent', () => {
    expect(resolveSharedOwnerId()).toBeUndefined();
  });

  it('treats a blank value as unset', () => {
    // `KEY=` in an env file is indistinguishable from an operator who meant to
    // leave the feature off, so it must not be an error and must not be an id.
    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '');
    expect(resolveSharedOwnerId()).toBeUndefined();

    vi.stubEnv('PERSISTENCE_SHARED_OWNER_ID', '   ');
    expect(resolveSharedOwnerId()).toBeUndefined();
  });

  it('returns the configured id, trimmed', () => {
    configure('team-alpha');
    expect(resolveSharedOwnerId()).toBe('team-alpha');

    configure('  team-alpha  ');
    expect(resolveSharedOwnerId()).toBe('team-alpha');
  });

  it('accepts every character the pattern allows', () => {
    configure('Team_1.2-3');
    expect(resolveSharedOwnerId()).toBe('Team_1.2-3');
  });

  it('rejects the reserved anonymous prefix', () => {
    // `anon:` is not in the allowed set, which is what keeps a shared id from
    // aliasing onto a cookie owner — and from being refused by `publish`, which
    // is the behaviour this setting exists to remove.
    configure('anon:00000000-0000-4000-8000-000000000000');
    expect(() => resolveSharedOwnerId()).toThrow(/PERSISTENCE_SHARED_OWNER_ID/);
  });

  it('rejects values the material-key sanitiser would rewrite', () => {
    // Any character outside the set is rewritten to `_` in material object
    // keys, where two different ids could then collide.
    for (const value of ['has space', 'slash/y', 'percent%', 'quote"', 'semi;colon', 'emoji🙂']) {
      configure(value);
      expect(() => resolveSharedOwnerId(), value).toThrow(/PERSISTENCE_SHARED_OWNER_ID/);
    }
  });

  it('rejects a value longer than the limit', () => {
    configure('a'.repeat(129));
    expect(() => resolveSharedOwnerId()).toThrow(/PERSISTENCE_SHARED_OWNER_ID/);
  });

  it('refuses to resolve without ACCESS_CODE, naming both variables', () => {
    // Otherwise every request on an ungated deployment would resolve to one
    // owner: one readable, editable and publishable library for whoever asks.
    // The message has to name both variables, since the fix is to set one or
    // unset the other and a reader should not have to guess which.
    configure('team-alpha', null);
    expect(() => resolveSharedOwnerId()).toThrow(/PERSISTENCE_SHARED_OWNER_ID[\s\S]*ACCESS_CODE/);
  });

  it('treats a blank ACCESS_CODE as absent', () => {
    // The middleware reads this the same way — an empty value leaves the gate
    // open, so it cannot satisfy the requirement.
    configure('team-alpha', '');
    expect(() => resolveSharedOwnerId()).toThrow(/ACCESS_CODE/);
  });
});

describe('the access-code gate in front of the shared owner', () => {
  // #1550 constraint 1. The resolver has no idea ACCESS_CODE exists — the
  // middleware is what keeps an unauthenticated request away from it. These two
  // pin that composition, so a change that served the shared owner before the
  // gate would fail here rather than shipping.

  it('refuses an unauthenticated request before owner resolution is reached', async () => {
    configure('team-alpha');

    const response = await middleware(stageRequest());

    expect(response.status).toBe(401);
  });

  it('applies the shared owner to a request that carries a valid access token', async () => {
    configure('team-alpha');
    const request = stageRequest(tokenFor(Date.now()));

    expect((await middleware(request)).status).toBe(200);

    const responseHeaders = new Headers();
    const ownerId = resolveRequestOwnerId(request, responseHeaders);
    expect(ownerId).toBe('team-alpha');
    expect(responseHeaders.has('set-cookie')).toBe(false);
  });
});
