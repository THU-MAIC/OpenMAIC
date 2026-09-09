/**
 * Per-hop redirect re-validation for provider fetches.
 *
 * `fetchWithRedirectValidation` fetches with `redirect: 'manual'` and re-runs
 * `validateUrlForSSRF` on every resolved `Location` before following it, so an
 * origin that answers `302` to a loopback/private/metadata address never gets
 * its redirect followed. The origin itself is assumed to have been validated
 * by the caller; the escape hatch (ALLOW_LOCAL_NETWORKS=true) still permits
 * redirects to local targets. DNS lookups are stubbed exactly like the
 * ssrf-guard tests so hostname classification is exercised end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    lookup: lookupMock,
  },
}));

async function loadWrapper() {
  return import('@/lib/server/fetch-with-redirect-validation');
}

describe('fetchWithRedirectValidation — every redirect hop is re-validated', () => {
  beforeEach(() => {
    vi.resetModules();
    lookupMock.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    // A hostname used as a safe redirect target resolves publicly.
    lookupMock.mockImplementation(async (hostname: string) => {
      if (hostname === 'cdn.public.example') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      throw new Error(`ENOTFOUND ${hostname}`);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALLOW_LOCAL_NETWORKS;
  });

  it('rejects a public origin that answers 302 to a loopback address and never fetches the target', async () => {
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/internal' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRedirectValidation('https://api.public.example/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(/Local\/private network URLs are not allowed/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(requestedUrls).toEqual(['https://api.public.example/v1/chat/completions']);
    expect(requestedUrls.join(' ')).not.toContain('127.0.0.1');
  });

  it('follows a 302 to another public address and returns the final response', async () => {
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.public.example/v1/chat/completions' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithRedirectValidation(
      'https://api.public.example/v1/chat/completions',
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      'https://cdn.public.example/v1/chat/completions',
    );
    // Every hop is fetched with manual redirect handling.
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).redirect).toBe('manual');
    }
    expect(lookupMock).toHaveBeenCalledWith('cdn.public.example', { all: true, verbatim: true });
  });

  it('fails a redirect chain longer than the hop limit', async () => {
    const { fetchWithRedirectValidation, MAX_REDIRECT_HOPS } = await loadWrapper();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.public.example/again' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchWithRedirectValidation('https://api.public.example/v1/chat/completions'),
    ).rejects.toThrow(`Provider request exceeded ${MAX_REDIRECT_HOPS} redirects`);

    // origin + MAX_REDIRECT_HOPS followed hops, then the extra redirect errors.
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REDIRECT_HOPS + 1);
  });

  it('still permits a redirect to a local address when ALLOW_LOCAL_NETWORKS=true', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:8080/internal' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithRedirectValidation(
      'https://api.public.example/v1/chat/completions',
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://127.0.0.1:8080/internal');
  });

  it('drops credential headers before a cross-origin hop when init.headers is a Headers instance, keeping the other headers', async () => {
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.public.example/v1/chat/completions' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const headers = new Headers({
      authorization: 'Bearer sk-test',
      'x-api-key': 'anthropic-key',
      'content-type': 'application/json',
    });

    const response = await fetchWithRedirectValidation(
      'https://api.public.example/v1/chat/completions',
      { method: 'POST', headers, body: '{}' },
    );

    expect(response.status).toBe(200);
    const firstInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect((firstInit.headers as Headers).get('authorization')).toBe('Bearer sk-test');
    const secondHeaders = (fetchMock.mock.calls[1][1] as RequestInit).headers as Headers;
    expect(secondHeaders).toBeInstanceOf(Headers);
    expect(secondHeaders.get('authorization')).toBeNull();
    expect(secondHeaders.get('x-api-key')).toBeNull();
    expect(secondHeaders.get('content-type')).toBe('application/json');
    // The caller's Headers instance is never mutated.
    expect(headers.get('authorization')).toBe('Bearer sk-test');
  });

  it('drops credential headers before a cross-origin hop when init.headers is an array of string pairs', async () => {
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.public.example/v1/chat/completions' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithRedirectValidation(
      'https://api.public.example/v1/chat/completions',
      {
        method: 'POST',
        headers: [
          ['authorization', 'Bearer sk-test'],
          ['api-key', 'azure-key'],
          ['content-type', 'application/json'],
        ],
        body: '{}',
      },
    );

    expect(response.status).toBe(200);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual([
      ['authorization', 'Bearer sk-test'],
      ['api-key', 'azure-key'],
      ['content-type', 'application/json'],
    ]);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual([
      ['content-type', 'application/json'],
    ]);
  });

  it('drops every credential spelling case-insensitively from a plain-object header block on a cross-origin hop', async () => {
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.public.example/v1/chat/completions' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const headers: Record<string, string> = {
      AUTHORIZATION: 'Bearer sk-test',
      'Api-Key': 'azure-key',
      'X-Api-Key': 'anthropic-key',
      'X-GOOG-API-KEY': 'google-key',
      'content-type': 'application/json',
    };

    const response = await fetchWithRedirectValidation(
      'https://api.public.example/v1/chat/completions',
      { method: 'POST', headers, body: '{}' },
    );

    expect(response.status).toBe(200);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual(headers);
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({
      'content-type': 'application/json',
    });
    // The caller's plain-object headers are never mutated.
    expect(headers.AUTHORIZATION).toBe('Bearer sk-test');
  });

  it('keeps credential headers on a same-origin redirect (different path, same host)', async () => {
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.public.example/v2/chat/completions' },
        }),
      )
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await fetchWithRedirectValidation(
      'https://cdn.public.example/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body: '{}',
      },
    );

    expect(response.status).toBe(200);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toEqual({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    });
  });

  it('fails clearly when a streaming request body cannot be replayed onto a redirect target', async () => {
    const { fetchWithRedirectValidation } = await loadWrapper();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.public.example/v1/chat/completions' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    });

    await expect(
      fetchWithRedirectValidation('https://api.public.example/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test' },
        body: body as BodyInit,
      }),
    ).rejects.toThrow(/cannot be replayed/);

    // Only the origin request is issued; no follow-up request carries the
    // consumed stream as an empty body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
