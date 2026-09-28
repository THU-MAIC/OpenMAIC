/**
 * `/api/verify-pdf-provider` probes run through the strict provider transport.
 *
 * These tests drive the real route, the real SSRF guard and the real pinned
 * transport against loopback HTTP servers. Only three things are stubbed:
 *
 *  - `@/lib/server/provider-config`, so each test chooses whether a provider is
 *    server-managed and what the server resolves for its key/base URL;
 *  - `node:dns`, so a hostname can answer the URL-layer guard and the
 *    connect-time lookup differently (DNS rebinding) or fail to resolve; and
 *  - the global `fetch`, replaced with a spy that must never be called — the
 *    probes have to go through the pinned undici transport instead.
 *
 * The timeout case also shortens `AbortSignal.timeout` so the 10s probe
 * deadline fires quickly.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { POST } from '@/app/api/verify-pdf-provider/route';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';

const mocks = vi.hoisted(() => ({
  isServerConfiguredProvider: vi.fn(),
  resolveManagedAliDocMindCredentials: vi.fn(),
  resolvePDFApiKey: vi.fn(),
  resolvePDFBaseUrl: vi.fn(),
  // Used by the URL-layer guard (`node:dns` promises API).
  promisesLookup: vi.fn(),
  // Used by the pinned dispatcher's connect-time lookup (callback API).
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  isServerConfiguredProvider: mocks.isServerConfiguredProvider,
  resolveManagedAliDocMindCredentials: mocks.resolveManagedAliDocMindCredentials,
  resolvePDFApiKey: mocks.resolvePDFApiKey,
  resolvePDFBaseUrl: mocks.resolvePDFBaseUrl,
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
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

const CONNECTION_FAILED = {
  status: 500,
  json: {
    success: false,
    errorCode: 'INTERNAL_ERROR',
    error: 'Cannot connect to server, please check the Base URL',
  },
};

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

const servers: Server[] = [];

interface LoopbackServer {
  port: number;
  origin: string;
  requests: () => number;
  lastUrl: () => string | undefined;
  lastHeaders: () => IncomingMessage['headers'] | undefined;
}

async function startLoopback(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  let count = 0;
  let url: string | undefined;
  let headers: IncomingMessage['headers'] | undefined;
  const server = createServer((req, res) => {
    count += 1;
    url = req.url;
    headers = req.headers;
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"detail":"Not Found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests: () => count,
    lastUrl: () => url,
    lastHeaders: () => headers,
  };
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function postVerifyPdfProvider(body: Record<string, unknown>) {
  const request = new Request('http://localhost/api/verify-pdf-provider', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await POST(request as unknown as NextRequest);
  return { status: res.status, json: await res.json() };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
const globalFetch = vi.fn();

describe('POST /api/verify-pdf-provider', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    destroyAudioProviderDispatchersForTests();
    delete process.env.ALLOW_LOCAL_NETWORKS;

    mocks.isServerConfiguredProvider.mockReturnValue(false);
    mocks.resolvePDFApiKey.mockImplementation(
      (_providerId: string, clientApiKey?: string) => clientApiKey,
    );
    mocks.resolvePDFBaseUrl.mockImplementation(
      (_providerId: string, clientBaseUrl?: string) => clientBaseUrl,
    );
    mocks.promisesLookup.mockResolvedValue(PUBLIC);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    globalFetch.mockReset();
    globalFetch.mockRejectedValue(new Error('global fetch must not be used'));
    vi.stubGlobal('fetch', globalFetch);
  });

  afterEach(async () => {
    // Every probe must have gone through the pinned undici transport.
    expect(globalFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
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

  describe('with the operator local-network opt-in', () => {
    beforeEach(() => {
      process.env.ALLOW_LOCAL_NETWORKS = 'true';
    });

    it('verifies a MinerU Cloud endpoint through the transport without echoing its status', async () => {
      const cloud = await startLoopback();

      const res = await postVerifyPdfProvider({
        providerId: 'mineru-cloud',
        apiKey: 'test-key',
        baseUrl: `${cloud.origin}/api/v4/`,
      });

      expect(res).toEqual({
        status: 200,
        json: { success: true, message: 'Connection successful' },
      });
      expect(cloud.requests()).toBe(1);
      expect(cloud.lastUrl()).toBe('/api/v4/extract-results/batch/test-connection');
      expect(cloud.lastHeaders()!.authorization).toBe('Bearer test-key');
    });

    it('verifies a self-hosted MinerU on a local network', async () => {
      const selfHosted = await startLoopback();

      const res = await postVerifyPdfProvider({
        providerId: 'mineru',
        baseUrl: selfHosted.origin,
      });

      expect(res).toEqual({
        status: 200,
        json: { success: true, message: 'Connection successful' },
      });
      expect(selfHosted.requests()).toBe(1);
    });

    it.each([401, 403])(
      'answers a MinerU Cloud %i with a fixed message and never echoes the body',
      async (status) => {
        const cloud = await startLoopback((_req, res) => {
          res.writeHead(status, { 'Content-Type': 'text/plain' });
          res.end('internal-secret-body');
        });

        const res = await postVerifyPdfProvider({
          providerId: 'mineru-cloud',
          apiKey: 'bad-key',
          baseUrl: cloud.origin,
        });

        expect(res).toEqual({
          status: 500,
          json: {
            success: false,
            errorCode: 'INTERNAL_ERROR',
            error: 'Authentication failed, please check the API Key',
          },
        });
        expect(JSON.stringify(res.json)).not.toContain('internal-secret-body');
        expect(cloud.requests()).toBe(1);
      },
    );

    it.each([
      ['mineru-cloud', 302],
      ['mineru', 308],
    ])('refuses a %s redirect (%i) and never follows it', async (providerId, status) => {
      const target = await startLoopback();
      const origin = await startLoopback((_req, res) => {
        res.writeHead(status, { Location: `${target.origin}/sink` });
        res.end('redirect response body');
      });

      const res = await postVerifyPdfProvider({
        providerId,
        apiKey: 'test-key',
        baseUrl: origin.origin,
      });

      expect(res).toEqual({
        status: 403,
        json: {
          success: false,
          errorCode: 'REDIRECT_NOT_ALLOWED',
          error: 'Redirects are not allowed',
        },
      });
      expect(origin.requests()).toBe(1);
      expect(target.requests()).toBe(0);
    });

    it('answers connection refused, unresolvable host and timeout identically', async () => {
      const refused = await postVerifyPdfProvider({
        providerId: 'mineru',
        baseUrl: `http://127.0.0.1:${await closedPort()}`,
      });

      mocks.callbackLookup.mockImplementation(
        (_hostname: string, _options: unknown, callback: (...args: unknown[]) => void) => {
          const error = Object.assign(new Error('getaddrinfo ENOTFOUND missing.test'), {
            code: 'ENOTFOUND',
          });
          callback(error);
        },
      );
      const notFound = await postVerifyPdfProvider({
        providerId: 'mineru',
        baseUrl: 'http://missing.test:8000',
      });
      mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

      const hanging = await startLoopback(() => {
        // Never answer; the probe deadline must fire.
      });
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(50));
      const timedOut = await postVerifyPdfProvider({
        providerId: 'mineru-cloud',
        apiKey: 'test-key',
        baseUrl: hanging.origin,
      });

      expect(refused).toEqual(CONNECTION_FAILED);
      expect(notFound).toEqual(CONNECTION_FAILED);
      expect(timedOut).toEqual(CONNECTION_FAILED);
      expect(hanging.requests()).toBe(1);
    });
  });

  it.each(['mineru-cloud', 'mineru'])(
    'refuses a %s host that rebinds to loopback between validation and connect',
    async (providerId) => {
      const trap = await startLoopback();

      const res = await postVerifyPdfProvider({
        providerId,
        apiKey: 'client-key',
        baseUrl: `http://rebind.test:${trap.port}`,
      });

      // The URL-layer guard saw the public answer and let the request through...
      expect(mocks.promisesLookup).toHaveBeenCalled();
      // ...the pinned connect-time lookup was offered loopback and refused it.
      expect(mocks.callbackLookup).toHaveBeenCalledWith(
        'rebind.test',
        expect.anything(),
        expect.any(Function),
      );
      expect(res).toEqual(CONNECTION_FAILED);
      // The socket never reached the rebound target, so the key never did either.
      expect(trap.requests()).toBe(0);
    },
  );

  it('still rejects a client-supplied loopback URL up front without the opt-in', async () => {
    const internal = await startLoopback();

    const res = await postVerifyPdfProvider({
      providerId: 'mineru',
      baseUrl: internal.origin,
    });

    expect(res.status).toBe(403);
    expect(res.json.errorCode).toBe('INVALID_URL');
    expect(internal.requests()).toBe(0);
  });

  it.each(['mineru-cloud', 'mineru'])(
    'ignores the client key and base URL for a server-managed %s provider',
    async (providerId) => {
      // No opt-in: a server-managed base URL is operator configuration and may
      // point at a local network.
      const managed = await startLoopback();
      const clientTarget = await startLoopback();
      mocks.isServerConfiguredProvider.mockReturnValue(true);
      mocks.resolvePDFBaseUrl.mockImplementation((_providerId: string, clientBaseUrl?: string) =>
        clientBaseUrl === undefined ? managed.origin : clientBaseUrl,
      );
      mocks.resolvePDFApiKey.mockImplementation((_providerId: string, clientApiKey?: string) =>
        clientApiKey === undefined ? 'server-key' : clientApiKey,
      );

      const res = await postVerifyPdfProvider({
        providerId,
        apiKey: 'client-key',
        baseUrl: clientTarget.origin,
      });

      expect(res).toEqual({
        status: 200,
        json: { success: true, message: 'Connection successful' },
      });
      expect(mocks.resolvePDFBaseUrl).toHaveBeenCalledWith(providerId, undefined);
      expect(mocks.resolvePDFApiKey).toHaveBeenCalledWith(providerId, undefined);
      expect(managed.requests()).toBe(1);
      expect(managed.lastHeaders()!.authorization).toBe('Bearer server-key');
      expect(clientTarget.requests()).toBe(0);
    },
  );

  it.each(['mineru-cloud', 'mineru'])(
    'still refuses cloud metadata as a server-managed %s base URL',
    async (providerId) => {
      mocks.isServerConfiguredProvider.mockReturnValue(true);
      mocks.resolvePDFBaseUrl.mockReturnValue('http://169.254.169.254/latest');
      mocks.resolvePDFApiKey.mockReturnValue('server-key');

      const res = await postVerifyPdfProvider({ providerId });

      expect(res).toEqual(CONNECTION_FAILED);
    },
  );

  it.each([
    ['mineru-cloud', '?'],
    ['mineru', '#'],
    ['mineru', '?x=1'],
  ])('refuses a client %s base URL ending in %s before any request', async (providerId, tail) => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const internal = await startLoopback();

    const res = await postVerifyPdfProvider({
      providerId,
      apiKey: 'client-key',
      baseUrl: `${internal.origin}/internal${tail}`,
    });

    expect(res).toEqual({
      status: 403,
      json: {
        success: false,
        errorCode: 'INVALID_URL',
        error: 'Base URL must not contain a query string or fragment',
      },
    });
    expect(internal.requests()).toBe(0);
  });
});
