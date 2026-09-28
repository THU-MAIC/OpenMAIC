/**
 * Real-transport coverage for the MinerU Cloud second hop.
 *
 * `mineru-cloud.test.ts` stubs the transport to assert policy wiring at the
 * parser level. This file drives the actual strict transport against loopback
 * HTTP servers, so it proves the two properties the parser relies on:
 *
 *  - the presigned PUT body (a platform `Blob` of the document bytes) arrives
 *    byte-for-byte through undici's own `fetch` with an undici dispatcher, with
 *    the same framing (no Content-Type, a correct Content-Length);
 *  - a response-supplied URL that answers a redirect to a private or metadata
 *    address is refused under the strict public policy and never followed;
 *  - a 3xx on the presigned upload (rejected via `rejectRedirects`) is a hard
 *    failure and the redirect target never receives the body; and
 *  - a hostname that rebinds to loopback between the URL-layer guard and the
 *    connect-time lookup is refused by the pinned dispatcher.
 *
 * The redirect origin is a loopback server because a genuinely public HTTPS
 * origin is not reachable from a hermetic test; the transport does not validate
 * the initial URL (the parser does that), so what is under test here is the
 * per-hop re-validation that runs on the answer.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  providerFetch,
  destroyAudioProviderDispatchersForTests,
} from '@/lib/server/provider-fetch';
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
  lastBody: () => Buffer | undefined;
}

async function startLoopback(
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<LoopbackServer> {
  let count = 0;
  let headers: IncomingMessage['headers'] | undefined;
  let body: Buffer | undefined;
  const server = createServer((req, res) => {
    count += 1;
    headers = req.headers;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length > 0) body = Buffer.concat(chunks);
      if (handler) {
        handler(req, res);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => count,
    lastHeaders: () => headers,
    lastBody: () => body,
  };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('providerFetch — MinerU Cloud second-hop transport', () => {
  beforeEach(() => {
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.callbackLookup.mockReset();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    destroyAudioProviderDispatchersForTests();
  });

  afterEach(async () => {
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

  it('delivers the presigned PUT body bytes intact with the same framing', async () => {
    const origin = await startLoopback();
    // Non-trivial binary payload so a truncation or text coercion is visible.
    const payload = Buffer.alloc(256 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

    const response = await providerFetch(
      `http://127.0.0.1:${origin.port}/upload/lesson.pdf`,
      { method: 'PUT', body: new Blob([payload]) },
      { allowLocalNetworks: true },
    );

    expect(response.status).toBe(200);
    const received = origin.lastBody()!;
    expect(received.length).toBe(payload.length);
    expect(received.equals(payload)).toBe(true);
    // `new Blob([...])` carries no media type, so no Content-Type is sent, and
    // undici frames the body with its own Content-Length.
    expect(origin.lastHeaders()!['content-type']).toBeUndefined();
    expect(origin.lastHeaders()!['content-length']).toBe(String(payload.length));
  });

  it('refuses a redirect from the second hop to a cloud metadata address and never follows it', async () => {
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });

    await expect(
      providerFetch(`http://127.0.0.1:${origin.port}/result.zip`, undefined, {
        allowLocalNetworks: false,
      }),
    ).rejects.toThrow('Cloud instance metadata endpoints are never allowed');

    expect(origin.requests()).toBe(1);
  });

  it('refuses a redirect from the second hop to a private address and never follows it', async () => {
    const internal = await startLoopback();
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${internal.port}/secret` });
      res.end();
    });

    await expect(
      providerFetch(`http://127.0.0.1:${origin.port}/result.zip`, undefined, {
        allowLocalNetworks: false,
      }),
    ).rejects.toThrow(/not allowed/);

    expect(origin.requests()).toBe(1);
    expect(internal.requests()).toBe(0);
  });

  it.each([301, 302, 303, 307, 308])(
    'refuses a %i redirect on the presigned upload PUT and never sends the body to the target',
    async (status) => {
      const target = await startLoopback();
      const origin = await startLoopback((_req, res) => {
        res.writeHead(status, { Location: `http://127.0.0.1:${target.port}/sink` });
        res.end();
      });
      const payload = Buffer.from('presigned-document-bytes');

      // The operator opt-in makes the loopback target otherwise followable, so
      // this isolates `rejectRedirects` as the guard that stops the hop. The
      // parser wires the upload with `allowLocalNetworks: false` on top, which
      // is asserted separately with the stubbed transport.
      await expect(
        providerFetch(
          `http://127.0.0.1:${origin.port}/upload/lesson.pdf`,
          { method: 'PUT', body: new Blob([payload]) },
          { allowLocalNetworks: true, rejectRedirects: true },
        ),
      ).rejects.toThrow();

      // The origin served the upload once and answered 3xx; the redirect target
      // never received a request (and therefore never the body).
      expect(origin.requests()).toBe(1);
      expect(target.requests()).toBe(0);
    },
  );

  it('refuses a hostname that rebinds to loopback between guard and connect for the result ZIP', async () => {
    const trap = await startLoopback();
    const url = `http://rebind.test:${trap.port}/result.zip`;

    // The URL-layer guard sees a public answer and passes...
    dnsMocks.promisesLookup.mockResolvedValue(PUBLIC);
    await expect(
      validateUrlForSSRFWithPolicy(url, { allowLocalNetworks: false }),
    ).resolves.toBeNull();

    // ...but the connect-time lookup is offered loopback instead.
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    // The ZIP request's policy (`requireHttps` only constrains redirect hops;
    // the guard/connect split below is what refuses this request).
    await expect(
      providerFetch(url, undefined, { allowLocalNetworks: false, requireHttps: true }),
    ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

    // A transport that ignored the pinned dispatcher would have connected here.
    expect(trap.requests()).toBe(0);
    expect(dnsMocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
  });
});
