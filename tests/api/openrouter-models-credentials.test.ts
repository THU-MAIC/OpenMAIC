/**
 * Credential-boundary tests for `/api/openrouter-models`.
 *
 * The route accepts a client-supplied `x-base-url`, and the operator may have a
 * server key in the environment. Pairing those two would let any caller steer
 * the operator's credential to a host of their choosing, so these tests pin the
 * boundary itself rather than the happy path: which key goes to which URL, and
 * that a rejected destination is never contacted at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ssrf = vi.hoisted(() => ({ validate: vi.fn(async () => null as string | null) }));
vi.mock('@/lib/server/ssrf-guard', () => ({ validateUrlForSSRF: ssrf.validate }));

const DEFAULT = 'https://openrouter.ai/api/v1';
const SERVER_KEY = 'server-side-operator-key';
const CLIENT_KEY = 'caller-own-key';

/**
 * A `NextRequest`-shaped stub. The route reads `nextUrl`, which plain `Request`
 * does not carry, so attach it rather than loosening the route for tests.
 */
function request(headers: Record<string, string> = {}, kind = 'image') {
  const url = `http://localhost/api/openrouter-models?kind=${kind}`;
  const req = new Request(url, { headers });
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) });
  return req;
}

/** Records every outbound call so assertions can pair URL with credential. */
function stubFetch(ok = true) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers as HeadersInit).get('authorization');
    calls.push({ url, auth });
    return new Response(JSON.stringify({ data: ok ? [{ id: 'm', name: 'M' }] : [] }), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** Fresh module per test: the route caches catalogs in module scope. */
async function loadRoute() {
  vi.resetModules();
  return (await import('@/app/api/openrouter-models/route')).GET;
}

beforeEach(() => {
  ssrf.validate.mockResolvedValue(null);
  delete process.env.IMAGE_OPENROUTER_API_KEY;
  delete process.env.IMAGE_OPENROUTER_BASE_URL;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/api/openrouter-models credential boundary', () => {
  it('never sends the server key to a client-supplied base URL', async () => {
    process.env.IMAGE_OPENROUTER_API_KEY = SERVER_KEY;
    const calls = stubFetch();
    const GET = await loadRoute();

    await GET(
      request({ 'x-base-url': 'https://attacker.example', 'x-api-key': CLIENT_KEY }) as never,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://attacker.example/images/models');
    // The caller's own key may go to the caller's own host; the operator's must not.
    expect(calls[0].auth).toBe(`Bearer ${CLIENT_KEY}`);
    expect(JSON.stringify(calls)).not.toContain(SERVER_KEY);
  });

  it('drops the server key even when the caller supplies no key of their own', async () => {
    process.env.IMAGE_OPENROUTER_API_KEY = SERVER_KEY;
    const calls = stubFetch();
    const GET = await loadRoute();

    await GET(request({ 'x-base-url': 'https://attacker.example' }) as never);

    expect(calls[0].auth).toBeNull();
    expect(JSON.stringify(calls)).not.toContain(SERVER_KEY);
  });

  it('sends the server key only to the operator-configured base URL', async () => {
    process.env.IMAGE_OPENROUTER_API_KEY = SERVER_KEY;
    process.env.IMAGE_OPENROUTER_BASE_URL = 'https://proxy.internal/v1';
    const calls = stubFetch();
    const GET = await loadRoute();

    await GET(request() as never);

    expect(calls[0].url).toBe('https://proxy.internal/v1/images/models');
    expect(calls[0].auth).toBe(`Bearer ${SERVER_KEY}`);
  });

  it('refuses an SSRF-rejected destination without contacting it', async () => {
    process.env.IMAGE_OPENROUTER_API_KEY = SERVER_KEY;
    ssrf.validate.mockResolvedValue('Private network addresses are not allowed');
    const calls = stubFetch();
    const GET = await loadRoute();

    const res = await GET(request({ 'x-base-url': 'http://169.254.169.254' }) as never);

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('does not serve one caller a catalog fetched with another caller key', async () => {
    const calls = stubFetch();
    const GET = await loadRoute();

    await GET(request({ 'x-base-url': 'https://tenant.example', 'x-api-key': 'key-a' }) as never);
    await GET(request({ 'x-base-url': 'https://tenant.example', 'x-api-key': 'key-b' }) as never);

    // Same URL, different credential ⇒ no cache reuse across callers.
    expect(calls.map((c) => c.auth)).toEqual(['Bearer key-a', 'Bearer key-b']);
  });

  it('falls back to the public catalog unauthenticated when the client URL fails', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers as HeadersInit).get('authorization');
        calls.push({ url, auth });
        const failed = url.startsWith('https://broken.example');
        return new Response(JSON.stringify({ data: failed ? [] : [{ id: 'm', name: 'M' }] }), {
          status: failed ? 500 : 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const GET = await loadRoute();

    await GET(
      request({ 'x-base-url': 'https://broken.example', 'x-api-key': CLIENT_KEY }) as never,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(`${DEFAULT}/images/models`);
    // A credential chosen for one host must not follow to another.
    expect(calls[1].auth).toBeNull();
  });

  it('normalises a pasted endpoint so the picker is not empty', async () => {
    const calls = stubFetch();
    const GET = await loadRoute();

    await GET(request({ 'x-base-url': `${DEFAULT}/images` }) as never);

    expect(calls[0].url).toBe(`${DEFAULT}/images/models`);
  });

  it('sends no Authorization header when nothing is configured', async () => {
    const calls = stubFetch();
    const GET = await loadRoute();

    await GET(request() as never);

    expect(calls[0].url).toBe(`${DEFAULT}/images/models`);
    expect(calls[0].auth).toBeNull();
  });
});
