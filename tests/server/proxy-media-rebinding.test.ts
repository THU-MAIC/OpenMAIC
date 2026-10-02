/**
 * Regression tests for DNS rebinding in `POST /api/proxy-media`.
 *
 * The route validates a URL and then fetches it. Resolving the hostname once
 * for validation and again at connect time lets an attacker answer a public
 * address to the guard and a loopback/metadata address to the socket. These
 * tests drive a real loopback HTTP server with a `node:dns` double so the
 * URL-layer guard and the pinned connect-time lookup see different answers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';

const dnsMocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => dnsMocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: dnsMocks.promisesLookup },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

type Answer = { address: string; family: number };

const PUBLIC: Answer[] = [{ address: '93.184.216.34', family: 4 }];
const LOOPBACK: Answer[] = [{ address: '127.0.0.1', family: 4 }];
const METADATA: Answer[] = [{ address: '169.254.169.254', family: 4 }];

const PRIVATE_BLOCK_MESSAGE = 'Local/private network URLs are not allowed';
const METADATA_BLOCK_MESSAGE = 'Cloud instance metadata endpoints are never allowed';

/** A callback-style `dns.lookup` stand-in that always returns `addresses`. */
function answerWith(addresses: Answer[]) {
  return (
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ): void => {
    if (options?.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0]!.address, addresses[0]!.family);
    }
  };
}

/**
 * Connect-time lookup that ignores the requested name and answers loopback,
 * standing in for attacker-controlled DNS. Installed as the *global* dispatcher
 * so a route that forgets to pass its own pinned dispatcher actually reaches the
 * loopback server, instead of failing for the unrelated reason that the
 * synthetic hostname does not resolve. `setGlobalDispatcher` writes the symbol
 * Node's bundled `fetch` reads, so the unpinned path is genuinely exercised.
 */
function answerLoopback(
  _hostname: string,
  options: { all?: boolean },
  callback: (...args: unknown[]) => void,
): void {
  if (options?.all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  } else {
    callback(null, '127.0.0.1', 4);
  }
}

async function postProxy(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/proxy-media/route');
  const req = new Request('http://localhost/api/proxy-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req as unknown as NextRequest);
}

interface LoopbackServer {
  port: number;
  requests: () => number;
}

const servers: Server[] = [];

async function startLoopback(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  let count = 0;
  const server = createServer((req, res) => {
    count += 1;
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { port, requests: () => count };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

let previousGlobalDispatcher: Dispatcher | undefined;
let attackerDispatcher: Agent | undefined;

describe('POST /api/proxy-media DNS-rebinding hardening', () => {
  beforeEach(() => {
    vi.resetModules();
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.callbackLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;

    // Make the unpinned fetch path actually connect: without this, a route that
    // drops its dispatcher would go red only because the synthetic hostname does
    // not resolve, not because the attacker reached the loopback server.
    previousGlobalDispatcher = getGlobalDispatcher();
    attackerDispatcher = new Agent({ connect: { lookup: answerLoopback as never } });
    setGlobalDispatcher(attackerDispatcher);
  });

  afterEach(async () => {
    if (previousGlobalDispatcher) {
      setGlobalDispatcher(previousGlobalDispatcher);
    }
    await attackerDispatcher?.destroy();
    attackerDispatcher = undefined;
    if (originalAllowLocal === undefined) {
      delete process.env.ALLOW_LOCAL_NETWORKS;
    } else {
      process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    }
    vi.unstubAllGlobals();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  it('refuses a hostname whose connect-time answer rebinds to loopback, with zero requests', async () => {
    const internal = await startLoopback();
    // The guard sees a public address; the socket is offered loopback instead.
    dnsMocks.promisesLookup.mockResolvedValue(PUBLIC);
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    const res = await postProxy({ url: `http://rebind.test:${internal.port}/secret` });

    // The global attacker dispatcher would have answered loopback here, so a
    // route that fails to pin its connect-time lookup reaches the server and
    // fails on this count before the response shape is even inspected.
    expect(internal.requests()).toBe(0);

    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ errorCode: 'INVALID_URL' });
    expect(json.error).toContain(PRIVATE_BLOCK_MESSAGE);
  });

  it('proxies a local target with ALLOW_LOCAL_NETWORKS=true through the pinned path', async () => {
    const media = await startLoopback();
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    dnsMocks.promisesLookup.mockResolvedValue(LOOPBACK);
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    const res = await postProxy({ url: `http://internal.test:${media.port}/image.png` });
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(body).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(media.requests()).toBe(1);
    // A runtime that silently ignored `init.dispatcher` would fall back to the
    // global attacker dispatcher and never run the pinned lookup at all.
    expect(dnsMocks.callbackLookup).toHaveBeenCalledWith(
      'internal.test',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('still refuses a metadata answer at connect time with ALLOW_LOCAL_NETWORKS=true', async () => {
    const nowhere = await startLoopback();
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    // The guard only sees a public answer and passes; the connect answer is metadata.
    dnsMocks.promisesLookup.mockResolvedValue(PUBLIC);
    dnsMocks.callbackLookup.mockImplementation(answerWith(METADATA));

    const res = await postProxy({ url: `http://metadata.test:${nowhere.port}/latest/meta-data/` });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ errorCode: 'INVALID_URL' });
    expect(json.error).toContain(METADATA_BLOCK_MESSAGE);
    expect(nowhere.requests()).toBe(0);
  });

  it('re-applies the dispatcher to a redirect target and refuses a connect-time rebind', async () => {
    const internal = await startLoopback();
    dnsMocks.promisesLookup.mockResolvedValue(PUBLIC); // both hops pass the URL-layer guard
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    const realFetch = globalThis.fetch;
    const dispatchersSeen: unknown[] = [];
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      dispatchersSeen.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
      const target =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (target.startsWith('https://redirect.test/')) {
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: `http://rebind.test:${internal.port}/secret` },
          }),
        );
      }
      // The redirect hop uses the real client and the dispatcher the route passed.
      return realFetch(input, init);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await postProxy({ url: 'https://redirect.test/start' });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ errorCode: 'INVALID_URL' });
    expect(json.error).toContain(PRIVATE_BLOCK_MESSAGE);
    expect(internal.requests()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dispatchersSeen[0]).toBeDefined();
    expect(dispatchersSeen[1]).toBeDefined();
  });

  /**
   * `Agent.close()` waits for in-flight requests to drain, and the route never
   * reads the body on its early-return paths, so an upstream that trickles
   * forever would hang the handler. These tests pin the dispatcher teardown to
   * `destroy()` by asserting the route settles well under a second.
   */
  it('returns a forwarded 404 promptly when the upstream body never ends', async () => {
    const slow = await startLoopback((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.write('not found');
      const trickle = setInterval(() => res.write('.'), 20);
      res.on('close', () => clearInterval(trickle));
    });
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    dnsMocks.promisesLookup.mockResolvedValue(LOOPBACK);
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    const started = Date.now();
    const res = await postProxy({ url: `http://trickle.test:${slow.port}/missing` });
    const elapsed = Date.now() - started;
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
    expect(elapsed).toBeLessThan(1000);
    expect(slow.requests()).toBe(1);
  });

  it('follows a 30x whose body never ends and still returns the final asset', async () => {
    const server = await startLoopback((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/final', 'Content-Type': 'text/plain' });
        res.write('redirecting');
        const trickle = setInterval(() => res.write('.'), 20);
        res.on('close', () => clearInterval(trickle));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from([9, 8, 7]));
    });
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    dnsMocks.promisesLookup.mockResolvedValue(LOOPBACK);
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    const started = Date.now();
    const res = await postProxy({ url: `http://trickle.test:${server.port}/start` });
    const elapsed = Date.now() - started;
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(body).toEqual(new Uint8Array([9, 8, 7]));
    expect(elapsed).toBeLessThan(1000);
    expect(server.requests()).toBe(2);
  });

  it('returns the size-cap 502 promptly when the upstream body never ends', async () => {
    const huge = await startLoopback((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(26 * 1024 * 1024),
      });
      res.write('x');
      const trickle = setInterval(() => res.write('.'), 20);
      res.on('close', () => clearInterval(trickle));
    });
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    dnsMocks.promisesLookup.mockResolvedValue(LOOPBACK);
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    const started = Date.now();
    const res = await postProxy({ url: `http://trickle.test:${huge.port}/huge` });
    const elapsed = Date.now() - started;
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json).toMatchObject({ errorCode: 'UPSTREAM_ERROR' });
    expect(elapsed).toBeLessThan(1000);
    expect(huge.requests()).toBe(1);
  });
});
