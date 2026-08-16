// The opt-in indirect byte egress of the asset contract, driven against a
// stub AssetStore over a real loopback server: redirect off by default, the
// 302 shape when opted in, the fallbacks when the byte layer cannot sign, and
// the rule that authorization runs before any URL is minted.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AssetId } from '../src/asset/id.js';
import type { AssetIndirectReadRequest, AssetPrincipal, AssetStore } from '../src/asset/types.js';
import { createAssetHttpHandler, type AssetHttpHandlerOptions } from '../src/server/asset.js';

const PRINCIPAL: AssetPrincipal = { key: 'principal-a' };
const BYTES = new Uint8Array([1, 2, 3, 4]);

/**
 * Indirect egress against the package's default one-hour grace. Enabling it
 * requires declaring the grace, so every test below states the reclamation
 * window its signed URLs live inside rather than inheriting a guess.
 */
const REDIRECT = { mode: 'redirect', collectionGraceMs: 60 * 60 * 1000 } as const;

interface StubStoreOptions {
  mime?: string;
  revision?: number;
  indirect?: (
    principal: AssetPrincipal,
    ref: string,
    request: AssetIndirectReadRequest,
  ) => Promise<{ url: string; revision: number } | null | undefined>;
}

function stubStore(options: StubStoreOptions = {}): AssetStore {
  const mime = options.mime ?? 'image/png';
  const revision = options.revision ?? 3;
  const store: AssetStore = {
    put: async () => 'ast_stub' as AssetId,
    identify: async () => ({ mime, revision, byteLength: BYTES.byteLength }),
    resolve: async () => ({ bytes: new Uint8Array(BYTES), mime, revision }),
    remove: async () => undefined,
    replace: async () => revision + 1,
  };
  if (options.indirect !== undefined) {
    store.resolveIndirect = vi.fn(options.indirect);
  }
  return store;
}

interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(
  store: AssetStore,
  options: Partial<AssetHttpHandlerOptions> = {},
): Promise<RunningServer> {
  const handler = createAssetHttpHandler(store, {
    authenticate: async () => PRINCIPAL,
    ...options,
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `manual`, so the test sees the 302 itself rather than the redirected response. */
function getBytes(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
  return fetch(`${url}/assets/ast_example/content`, { method, redirect: 'manual' });
}

describe('asset byte egress', () => {
  test('serves bytes directly by default, even when the store can sign', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }));

    const response = await getBytes(url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-asset-revision')).toBe('3');
    expect(indirect).not.toHaveBeenCalled();
  });

  test('answers 302 with a signed Location when opted in and the store can sign', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await getBytes(url);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://objects.example/signed');
    // The redirect repeats the read route's posture: revision, no-store, and
    // the credential variance, with no body.
    expect(response.headers.get('x-asset-revision')).toBe('3');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization, Accept');
    expect(await response.text()).toBe('');
  });

  test('answers a descriptor request with the signed URL in a JSON body, never a redirect', async () => {
    // The packaged client asks for this shape through Accept -- CORS-safelisted,
    // so the negotiation adds no preflight -- and fetches the signed URL
    // itself, so its credential headers never approach the object store.
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await fetch(`${url}/assets/ast_example/content`, {
      headers: { accept: 'application/vnd.openmaic.asset-descriptor+json' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openmaic.asset-descriptor+json',
    );
    expect(response.headers.get('x-asset-revision')).toBe('3');
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({
      url: 'https://objects.example/signed',
      revision: 3,
    });
  });

  test('a descriptor range with q=0 selects the redirect instead', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await fetch(`${url}/assets/ast_example/content`, {
      redirect: 'manual',
      headers: { accept: 'application/vnd.openmaic.asset-descriptor+json;q=0' },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://objects.example/signed');
  });

  test('a longer media type containing the descriptor token selects the redirect', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await fetch(`${url}/assets/ast_example/content`, {
      redirect: 'manual',
      headers: { accept: 'application/vnd.openmaic.asset-descriptor+json-seq' },
    });

    expect(response.status).toBe(302);
  });

  test('media type matching is case-insensitive, as HTTP requires', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await fetch(`${url}/assets/ast_example/content`, {
      headers: { accept: 'Application/Vnd.OpenMAIC.Asset-Descriptor+JSON' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openmaic.asset-descriptor+json',
    );
  });

  test('mints the URL under the same authorization and labelling as a direct read', async () => {
    let seen:
      | { principal: AssetPrincipal; ref: string; request: AssetIndirectReadRequest }
      | undefined;
    const indirect = vi.fn(
      async (principal: AssetPrincipal, ref: string, request: AssetIndirectReadRequest) => {
        seen = { principal, ref, request };
        return { url: 'https://objects.example/signed', revision: 7 };
      },
    );
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await getBytes(url);

    expect(response.status).toBe(302);
    expect(indirect).toHaveBeenCalledOnce();
    expect(seen?.principal).toEqual(PRINCIPAL);
    expect(seen?.ref).toBe('ast_example');
    // The label reproduces the direct response's allowlist outcome, so the
    // signature pins what the direct path would have served.
    expect(seen?.request.cacheControl).toBe('private, no-store');
    expect(seen?.request.expiresInSeconds).toBe(60);
    expect(seen?.request.label('image/png')).toEqual({ contentType: 'image/png' });
    expect(seen?.request.label('text/plain')).toEqual({
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
    });
    expect(seen?.request.label('IMAGE/PNG')).toEqual({ contentType: 'image/png' });
  });

  test('passes a configured signed URL lifetime through to the store', async () => {
    let ttl = 0;
    const indirect = vi.fn(
      async (_principal: AssetPrincipal, _ref: string, request: AssetIndirectReadRequest) => {
        ttl = request.expiresInSeconds;
        return { url: 'https://objects.example/signed', revision: 3 };
      },
    );
    const { url } = await serve(stubStore({ indirect }), {
      byteEgress: { ...REDIRECT, signedUrlTtlSeconds: 5 },
    });

    const response = await getBytes(url);

    expect(response.status).toBe(302);
    expect(ttl).toBe(5);
  });

  test('falls back to direct bytes when the store declines to sign', async () => {
    const indirect = vi.fn(async () => undefined);
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await getBytes(url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(indirect).toHaveBeenCalledOnce();
  });

  test('falls back to direct bytes when the store has no indirect resolution', async () => {
    const { url } = await serve(stubStore(), { byteEgress: REDIRECT });

    const response = await getBytes(url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  test('a miss under indirect egress is the same 404 as a direct miss', async () => {
    const indirect = vi.fn(async () => null);
    const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

    const response = await getBytes(url);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-error-code')).toBe('ASSET_NOT_FOUND');
  });

  test('authorization runs before any URL is minted', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const denied = await serve(stubStore({ indirect }), {
      byteEgress: REDIRECT,
      authorizeAssets: async () => false,
    });

    const deniedResponse = await getBytes(denied.url);

    expect(deniedResponse.status).toBe(403);
    expect(deniedResponse.headers.get('x-error-code')).toBe('FORBIDDEN_ASSETS');
    expect(indirect).not.toHaveBeenCalled();

    const unauthenticated = await serve(stubStore({ indirect }), {
      byteEgress: REDIRECT,
      authenticate: async () => undefined,
    });

    const unauthenticatedResponse = await getBytes(unauthenticated.url);

    expect(unauthenticatedResponse.status).toBe(401);
    expect(indirect).not.toHaveBeenCalled();
  });

  test('HEAD never redirects, so revision revalidation stays direct', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const store = stubStore({ indirect });
    const resolve = vi.spyOn(store, 'resolve');
    const { url } = await serve(store, { byteEgress: REDIRECT });

    const response = await getBytes(url, 'HEAD');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-asset-revision')).toBe('3');
    expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(indirect).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a non-http(s) signed URL fails internally with 500 and emits no descriptor or Location', async () => {
    // The handler must never emit a signed URL a client would fetch: anything
    // that is not an absolute http(s) URL fails before a descriptor body or a
    // Location header is produced.
    for (const bad of ['not-a-url', 'ftp://objects.example/signed', '//objects.example/signed']) {
      const indirect = vi.fn(async () => ({ url: bad, revision: 3 }));
      const { url } = await serve(stubStore({ indirect }), { byteEgress: REDIRECT });

      const redirect = await getBytes(url);
      expect(redirect.status).toBe(500);
      expect(redirect.headers.get('location')).toBeNull();
      // The failure body must never carry the refused URL.
      expect(await redirect.text()).not.toContain('objects.example');

      const descriptor = await fetch(`${url}/assets/ast_example/content`, {
        headers: { accept: 'application/vnd.openmaic.asset-descriptor+json' },
      });
      expect(descriptor.status).toBe(500);
      expect(descriptor.headers.get('content-type')).toBe('application/json');
      expect(await descriptor.text()).not.toContain('objects.example');
    }
  });

  test('a signed URL lifetime above the handler ceiling is rejected at construction', () => {
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        // Inside a very long grace, so only the handler's own ceiling refuses it.
        byteEgress: { mode: 'redirect', collectionGraceMs: 30 * 24 * 3600 * 1000 },
      }),
    ).not.toThrow();
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        byteEgress: {
          mode: 'redirect',
          collectionGraceMs: 30 * 24 * 3600 * 1000,
          signedUrlTtlSeconds: 901,
        },
      }),
    ).toThrow(/signedUrlTtlSeconds must not exceed 900/);
  });

  test('a signed URL lifetime that could outlive its object is rejected at construction', () => {
    // The collector can delete an object one grace period after its last
    // reference goes; a URL still valid then would error at the object store.
    // The grace is a required part of enabling indirect egress precisely so
    // this is decided here rather than left to a consumer to check.
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        byteEgress: { mode: 'redirect', collectionGraceMs: 30_000, signedUrlTtlSeconds: 60 },
      }),
    ).toThrow(/must stay far below the collection grace period/);
    // The default lifetime is checked against the grace too, not only an
    // explicitly configured one.
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        byteEgress: { mode: 'redirect', collectionGraceMs: 30_000 },
      }),
    ).toThrow(/must stay far below the collection grace period/);
  });

  test('a malformed egress mode is rejected at construction', () => {
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        byteEgress: 'proxy' as never,
      }),
    ).toThrow(/byteEgress must be "direct" or \{ mode: "redirect", collectionGraceMs \}/);
    // The old flat shape, in case a consumer carries it forward.
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        byteEgress: 'redirect' as never,
      }),
    ).toThrow(/byteEgress must be "direct" or \{ mode: "redirect", collectionGraceMs \}/);
  });

  test('the descriptor media type is reserved from the renderable allowlist', () => {
    // The client identifies a descriptor answer by this exact Content-Type;
    // a served asset must never carry it.
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        renderableTypes: ['image/png', 'application/vnd.openmaic.asset-descriptor+json'],
      }),
    ).toThrow(/must not contain the asset descriptor media type/);
  });
});
