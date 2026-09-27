import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { ACCESS_TOKEN_MAX_AGE_SECONDS } from '@/lib/server/access-token-shared';
import { ATTEMPT_LIMIT_MAX_FAILURES } from '@/lib/server/attempt-limiter';

const mocks = vi.hoisted(() => ({
  cookieSet: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: mocks.cookieSet,
  }),
}));

const ACCESS_CODE = 'demo-code';
const LONG_ACCESS_CODE = 'a'.repeat(32);
const MAX_FAILURES = ATTEMPT_LIMIT_MAX_FAILURES;

type VerifyPost = (request: Request) => Promise<Response>;

/** Re-import the route so each test gets a fresh in-process limiter. */
async function loadPost(): Promise<VerifyPost> {
  vi.resetModules();
  const { POST } = await import('@/app/api/access-code/verify/route');
  return POST;
}

function verifyRequest(
  code: string | undefined,
  headers: Record<string, string> = {},
): NextRequest {
  const body = code === undefined ? {} : { code };
  return new NextRequest('http://localhost/api/access-code/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function failTimes(
  POST: VerifyPost,
  times: number,
  headers: Record<string, string> = {},
): Promise<void> {
  for (let i = 0; i < times; i++) {
    const res = await POST(verifyRequest('wrong-code', headers));
    expect(res.status).toBe(401);
  }
}

beforeEach(() => {
  mocks.cookieSet.mockReset();
  process.env.ACCESS_CODE = ACCESS_CODE;
  delete process.env.TRUST_PROXY_HEADERS;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.ACCESS_CODE;
  delete process.env.TRUST_PROXY_HEADERS;
});

describe('POST /api/access-code/verify — shared identity (untrusted, no throttle)', () => {
  it('evaluates all 50 concurrent wrong guesses without returning 429', async () => {
    const POST = await loadPost();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => POST(verifyRequest('wrong-code'))),
    );

    expect(responses.every((res) => res.status === 401)).toBe(true);
  });

  it('always accepts a correct code regardless of prior failures', async () => {
    const POST = await loadPost();

    await failTimes(POST, 100);

    const res = await POST(verifyRequest(ACCESS_CODE));
    expect(res.status).toBe(200);
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
  });

  it('ignores x-forwarded-for when TRUST_PROXY_HEADERS is unset', async () => {
    const POST = await loadPost();
    const headers = { 'x-forwarded-for': '10.0.0.2' };

    await failTimes(POST, 50, headers);

    expect((await POST(verifyRequest(ACCESS_CODE, headers))).status).toBe(200);
  });

  it('rejects a malformed or null body without a 500 and without limiting later requests', async () => {
    const POST = await loadPost();

    const nullBody = new NextRequest('http://localhost/api/access-code/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    expect((await POST(nullBody)).status).toBe(401);

    // Nothing was counted, so later requests are unaffected.
    await failTimes(POST, 50);
    expect((await POST(verifyRequest(ACCESS_CODE))).status).toBe(200);
  });
});

describe('POST /api/access-code/verify — trusted identity (TRUST_PROXY_HEADERS=true)', () => {
  beforeEach(() => {
    process.env.TRUST_PROXY_HEADERS = 'true';
  });

  it(`evaluates at most ${MAX_FAILURES} concurrent guesses from one forwarded IP`, async () => {
    const POST = await loadPost();
    const headers = { 'x-forwarded-for': '10.0.0.9' };

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => POST(verifyRequest('wrong-code', headers))),
    );

    const evaluated = responses.filter((res) => res.status === 401);
    const limited = responses.filter((res) => res.status === 429);

    expect(evaluated.length).toBeLessThanOrEqual(MAX_FAILURES);
    expect(limited).toHaveLength(50 - evaluated.length);
    for (const res of limited) {
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    }
  });

  it(`locks out one identity after ${MAX_FAILURES} failures with a positive Retry-After`, async () => {
    const POST = await loadPost();
    const headers = { 'x-forwarded-for': '10.0.0.1' };

    await failTimes(POST, MAX_FAILURES, headers);
    const res = await POST(verifyRequest('wrong-code', headers));

    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it('clears only the successful identity and leaves other clients untouched', async () => {
    const POST = await loadPost();
    const alice = { 'x-forwarded-for': '10.0.0.1' };
    const bob = { 'x-forwarded-for': '10.0.0.2' };

    // Lock Bob out.
    await failTimes(POST, MAX_FAILURES, bob);
    expect((await POST(verifyRequest('wrong-code', bob))).status).toBe(429);

    // Alice fails almost to the budget, then succeeds, which clears Alice only.
    await failTimes(POST, MAX_FAILURES - 1, alice);
    expect((await POST(verifyRequest(ACCESS_CODE, alice))).status).toBe(200);

    // Alice starts from a clean counter again.
    await failTimes(POST, MAX_FAILURES, alice);
    // Bob is still locked out: Alice's success did not clear him.
    expect((await POST(verifyRequest('wrong-code', bob))).status).toBe(429);
  });

  it('allows a different forwarded IP to authenticate while one is locked out', async () => {
    const POST = await loadPost();
    await failTimes(POST, MAX_FAILURES, { 'x-forwarded-for': '10.0.0.1' });
    expect(
      (await POST(verifyRequest('wrong-code', { 'x-forwarded-for': '10.0.0.1' }))).status,
    ).toBe(429);

    expect((await POST(verifyRequest(ACCESS_CODE, { 'x-forwarded-for': '10.0.0.2' }))).status).toBe(
      200,
    );
  });

  it('consults the trusted-identity limiter before reading the request body', async () => {
    const POST = await loadPost();
    const headers = { 'x-forwarded-for': '10.0.0.77' };
    await failTimes(POST, MAX_FAILURES, headers);

    let bodyReads = 0;
    const hanging = {
      headers: new Headers(headers),
      json: () => {
        bodyReads += 1;
        return new Promise<never>(() => {});
      },
    } as unknown as Request;

    const statuses: number[] = [];
    void POST(hanging).then((res) => statuses.push(res.status));
    // Drain microtasks only. A limiter consulted before `request.json()` settles
    // here; one consulted after it would await the never-resolving body.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(bodyReads).toBe(0);
    expect(statuses).toEqual([429]);
  });
});

describe('POST /api/access-code/verify — cookie', () => {
  it('sets the access cookie maxAge from the shared token lifetime', async () => {
    const POST = await loadPost();

    const res = await POST(verifyRequest(ACCESS_CODE));

    expect(res.status).toBe(200);
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
    const [, , options] = mocks.cookieSet.mock.calls[0];
    expect(options.maxAge).toBe(ACCESS_TOKEN_MAX_AGE_SECONDS);
  });
});

describe('POST /api/access-code/verify — short-code warning', () => {
  it('warns once for a short code and never logs the code itself', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const POST = await loadPost();

    await POST(verifyRequest('wrong-code'));
    await POST(verifyRequest('wrong-code'));

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0].map((part) => String(part)).join(' ');
    expect(message).toContain('shorter than 16');
    expect(message).not.toContain(ACCESS_CODE);
  });

  it('does not warn for a long code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ACCESS_CODE = LONG_ACCESS_CODE;
    const POST = await loadPost();

    await POST(verifyRequest('wrong-code'));
    await POST(verifyRequest('wrong-code'));

    expect(warn).not.toHaveBeenCalled();
  });

  it('measures code points, so an 8-emoji code still warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Eight code points, sixteen UTF-16 code units.
    process.env.ACCESS_CODE = '😀'.repeat(8);
    const POST = await loadPost();

    await POST(verifyRequest('wrong-code'));

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for a 16-code-point ASCII code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ACCESS_CODE = 'a'.repeat(16);
    const POST = await loadPost();

    await POST(verifyRequest('wrong-code'));

    expect(warn).not.toHaveBeenCalled();
  });
});
