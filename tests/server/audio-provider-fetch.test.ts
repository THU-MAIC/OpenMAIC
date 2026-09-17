/**
 * Live regression tests for the strict audio-provider transport.
 *
 * `audioProviderFetch` is the one helper every `lib/audio` provider request now
 * goes through. These tests drive real loopback HTTP servers so both halves of
 * the protection are exercised end to end:
 *
 *  - a `302` answer to a loopback/metadata address is re-validated at the URL
 *    layer and never followed; and
 *  - a hostname whose DNS answer changes between the URL-layer guard and the
 *    connect-time lookup (rebinding) is refused by the pinned dispatcher before
 *    a socket reaches the private address.
 *
 * The transport is undici's own `fetch` with an undici Agent, so a dispatcher
 * that the transport silently ignored would let the rebinding test reach the
 * internal server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audioProviderFetch,
  destroyAudioProviderDispatchersForTests,
} from '@/lib/server/audio-provider-fetch';
import { validateUrlForSSRFWithPolicy } from '@/lib/server/ssrf-guard';

const dnsMocks = vi.hoisted(() => ({
  // Used by the URL-layer guard (`node:dns` promises API).
  promisesLookup: vi.fn(),
  // Used by the pinned dispatcher's connect-time lookup (callback API).
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

type Answer = { address: string; family: number };

const PUBLIC: Answer[] = [{ address: '93.184.216.34', family: 4 }];
const LOOPBACK: Answer[] = [{ address: '127.0.0.1', family: 4 }];

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

const servers: Server[] = [];

interface LoopbackServer {
  port: number;
  requests: () => number;
  lastHeaders: () => IncomingMessage['headers'] | undefined;
}

async function startLoopback(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  let count = 0;
  let headers: IncomingMessage['headers'] | undefined;
  const server = createServer((req, res) => {
    count += 1;
    headers = req.headers;
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => count,
    lastHeaders: () => headers,
  };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('audioProviderFetch — redirect + rebinding hardening', () => {
  beforeEach(() => {
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.callbackLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    destroyAudioProviderDispatchersForTests();
  });

  afterEach(async () => {
    destroyAudioProviderDispatchersForTests();
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

  it('returns a normal 200 response and its body', async () => {
    const origin = await startLoopback();

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/audio/speech`,
      { method: 'POST', body: '{}' },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(origin.requests()).toBe(1);
  });

  it('refuses a 302 to a cloud metadata address and never follows it', async () => {
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });

    await expect(
      audioProviderFetch(`http://127.0.0.1:${origin.port}/start`, undefined, {
        allowLocalNetworks: false,
      }),
    ).rejects.toThrow(METADATA_BLOCK_MESSAGE);

    expect(origin.requests()).toBe(1);
  });

  it('refuses a 302 to a loopback address under the strict public policy', async () => {
    const internal = await startLoopback();
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/secret` });
      res.end();
    });

    await expect(
      audioProviderFetch(`http://127.0.0.1:${origin.port}/start`, undefined, {
        allowLocalNetworks: false,
      }),
    ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

    expect(origin.requests()).toBe(1);
    expect(internal.requests()).toBe(0);
  });

  it('follows a 302 to a loopback address when the operator policy allows local networks', async () => {
    const internal = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/final` });
      res.end();
    });

    const response = await audioProviderFetch(`http://127.0.0.1:${origin.port}/start`, undefined, {
      allowLocalNetworks: true,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
    expect(internal.requests()).toBe(1);
  });

  it('refuses a hostname that rebinds to loopback between guard and connect', async () => {
    const internal = await startLoopback();
    const url = `http://rebind.test:${internal.port}/secret`;

    // The URL-layer guard sees a public answer and passes...
    dnsMocks.promisesLookup.mockResolvedValue(PUBLIC);
    await expect(
      validateUrlForSSRFWithPolicy(url, { allowLocalNetworks: false }),
    ).resolves.toBeNull();

    // ...but the connect-time lookup is offered loopback instead.
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    await expect(audioProviderFetch(url, undefined, { allowLocalNetworks: false })).rejects.toThrow(
      PRIVATE_BLOCK_MESSAGE,
    );

    // A transport that ignored the pinned dispatcher would have connected here.
    expect(internal.requests()).toBe(0);
    expect(dnsMocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('strips provider credential headers before a cross-origin redirect hop', async () => {
    const internal = await startLoopback((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/final` });
      res.end();
    });

    const response = await audioProviderFetch(
      `http://127.0.0.1:${origin.port}/start`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer secret',
          'Ocp-Apim-Subscription-Key': 'azure-secret',
          'xi-api-key': 'eleven-secret',
          'content-type': 'application/json',
        },
      },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    const headers = internal.lastHeaders()!;
    expect(headers.authorization).toBeUndefined();
    expect(headers['ocp-apim-subscription-key']).toBeUndefined();
    expect(headers['xi-api-key']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');
  });
});
