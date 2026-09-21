import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAIM_TTL_MS } from '@/lib/persistence/claim-code';
import { ATTEMPT_LIMIT_MAX_FAILURES } from '@/lib/server/attempt-limiter';

/** Device A's identity, planted as an already-issued anonymous cookie. */
const OWNER_UUID = '11111111-1111-4111-8111-111111111111';
const DEVICE_A_COOKIE = `anonymous_id=${OWNER_UUID}`;
const TRUSTED_CLIENT = { 'x-forwarded-for': '203.0.113.7' };

type Handler = (request: Request) => Promise<Response>;

/**
 * Re-import both routes together so they share one fresh claim store and one
 * fresh attempt limiter — both live in module state.
 */
async function loadRoutes(): Promise<{ mint: Handler; redeem: Handler }> {
  vi.resetModules();
  const mint = await import('@/app/api/claim/route');
  const redeem = await import('@/app/api/claim/redeem/route');
  return { mint: mint.POST, redeem: redeem.POST };
}

function claimRequest(cookie?: string): Request {
  return new Request('http://localhost/api/claim', {
    method: 'POST',
    headers: cookie ? { cookie } : {},
  });
}

function redeemRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/claim/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function mintCode(mint: Handler): Promise<string> {
  const response = await mint(claimRequest(DEVICE_A_COOKIE));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { code: string };
  return body.code;
}

/** Status plus raw body — what a caller can actually tell apart. */
async function shape(response: Response): Promise<string> {
  return `${response.status} ${await response.text()}`;
}

beforeEach(() => {
  delete process.env.TRUST_PROXY_HEADERS;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.TRUST_PROXY_HEADERS;
});

describe('POST /api/claim/redeem — the three failure modes', () => {
  it('answers wrong, expired and already-used identically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { mint, redeem } = await loadRoutes();

    const wrongCode = await shape(await redeem(redeemRequest({ code: 'not-a-real-code' })));

    const spent = await mintCode(mint);
    expect((await redeem(redeemRequest({ code: spent }))).status).toBe(200);
    const alreadyUsed = await shape(await redeem(redeemRequest({ code: spent })));

    const stale = await mintCode(mint);
    vi.setSystemTime(Date.now() + CLAIM_TTL_MS + 1);
    const expired = await shape(await redeem(redeemRequest({ code: stale })));

    expect(
      new Set([wrongCode, expired, alreadyUsed]).size,
      'claim failure modes are distinguishable',
    ).toBe(1);
    expect(wrongCode.startsWith('401 ')).toBe(true);
  });

  it('answers a malformed body the same way', async () => {
    const { redeem } = await loadRoutes();

    const malformed = await shape(await redeem(redeemRequest('{ not json')));
    const missingField = await shape(await redeem(redeemRequest({})));
    const wrongCode = await shape(await redeem(redeemRequest({ code: 'nope' })));

    expect(
      new Set([malformed, missingField, wrongCode]).size,
      'claim failure modes are distinguishable',
    ).toBe(1);
  });

  it('leaks no owner identity on a rejected attempt', async () => {
    const { mint, redeem } = await loadRoutes();
    await mintCode(mint);

    const response = await redeem(redeemRequest({ code: 'nope' }));

    expect(await response.text()).not.toContain(OWNER_UUID);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('POST /api/claim/redeem — attempt cadence', () => {
  it('blocks the attempt past the declared budget instead of scoring it', async () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    const { redeem } = await loadRoutes();

    for (let attempt = 0; attempt < ATTEMPT_LIMIT_MAX_FAILURES; attempt += 1) {
      const response = await redeem(redeemRequest({ code: 'nope' }, TRUSTED_CLIENT));
      expect(response.status).toBe(401);
    }

    const blocked = await redeem(redeemRequest({ code: 'nope' }, TRUSTED_CLIENT));

    expect(blocked.status, 'claim redeem accepted unlimited attempts').toBe(429);
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
  });

  it('does not let one client spend another client’s budget', async () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    const { redeem } = await loadRoutes();

    for (let attempt = 0; attempt <= ATTEMPT_LIMIT_MAX_FAILURES; attempt += 1) {
      await redeem(redeemRequest({ code: 'nope' }, TRUSTED_CLIENT));
    }

    const other = await redeem(
      redeemRequest({ code: 'nope' }, { 'x-forwarded-for': '203.0.113.9' }),
    );

    expect(other.status).toBe(401);
  });
});

describe('POST /api/claim/redeem — adopting the first device', () => {
  it('hands device B the owner cookie of device A', async () => {
    const { mint, redeem } = await loadRoutes();
    const code = await mintCode(mint);

    // Device B arrives with no cookie of its own.
    const response = await redeem(redeemRequest({ code }));

    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0], 'redeem minted a fresh owner instead of adopting').toContain(
      `anonymous_id=${OWNER_UUID}`,
    );
    expect(cookies[0]).toContain('HttpOnly');
  });

  it('replaces device B’s own identity rather than keeping it', async () => {
    const { mint, redeem } = await loadRoutes();
    const code = await mintCode(mint);
    const deviceBOwn = 'anonymous_id=22222222-2222-4222-8222-222222222222';

    const response = await redeem(redeemRequest({ code }, { cookie: deviceBOwn }));

    expect(
      response.headers.getSetCookie()[0],
      'redeem minted a fresh owner instead of adopting',
    ).toContain(`anonymous_id=${OWNER_UUID}`);
  });

  it('refuses a second redemption and leaves the identity alone', async () => {
    const { mint, redeem } = await loadRoutes();
    const code = await mintCode(mint);

    expect((await redeem(redeemRequest({ code }))).status).toBe(200);
    const replay = await redeem(redeemRequest({ code }));

    expect(replay.status, 'claim code was redeemable twice').toBe(401);
    expect(replay.headers.getSetCookie()).toEqual([]);
  });
});

describe('POST /api/claim', () => {
  it('mints an owner cookie for a first-time device so the code adopts a real identity', async () => {
    const { mint, redeem } = await loadRoutes();

    const minted = await mint(claimRequest());
    const cookies = minted.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const issued = /anonymous_id=([^;]+)/.exec(cookies[0])?.[1];
    expect(issued).toBeTruthy();

    const { code, expiresAt } = (await minted.json()) as { code: string; expiresAt: number };
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(CLAIM_TTL_MS);

    const adopted = await redeem(redeemRequest({ code }));
    expect(adopted.headers.getSetCookie()[0]).toContain(`anonymous_id=${issued}`);
  });
});
