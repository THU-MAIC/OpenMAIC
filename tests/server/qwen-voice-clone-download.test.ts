/**
 * Live regression tests for the Qwen voice-clone audio download hop.
 *
 * `downloadAudio` keeps a strict result-host allowlist and `redirect: 'error'`,
 * but it used the global (unpinned) `fetch`, so the connect re-resolved the
 * hostname and a DNS-rebinding answer could steer the socket to an internal
 * address. It now validates the target at the URL layer under the server-side
 * policy and issues the request through the pinned transport.
 *
 * These tests drive real loopback HTTP servers plus a `node:dns` double so:
 *
 *  - a normal download from an allowlisted host still works;
 *  - a hostname that is public at the URL-layer check but loopback at connect
 *    is refused with ZERO connections to the internal server;
 *  - a host outside the allowlist is still refused before any transport; and
 *  - a redirect on this hop is still a hard failure and is never followed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadAudio } from '@/lib/audio/qwen-voice-clone';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/audio-provider-fetch';

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
}

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
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    requests: () => count,
  };
}

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

describe('downloadAudio — pinned download hop', () => {
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

  it('downloads a normal 200 from an allowlisted host and returns its bytes', async () => {
    // A server-managed/default endpoint may inherit the operator's local-network
    // opt-in; the configured host is the allowlisted result host for this config.
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const origin = await startLoopback();
    dnsMocks.promisesLookup.mockResolvedValue(LOOPBACK);
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    const downloaded = await downloadAudio(
      `http://download.test:${origin.port}/clip.wav`,
      undefined,
      `http://download.test:${origin.port}/api/v1`,
      false,
    );

    expect(downloaded.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(downloaded.contentType).toBe('audio/wav');
    expect(origin.requests()).toBe(1);
  });

  it('refuses a rebinding answer with zero connections to the internal server', async () => {
    const internal = await startLoopback();
    const url = `http://rebind.test:${internal.port}/clip.wav`;

    // The URL-layer check sees a public address and passes...
    dnsMocks.promisesLookup.mockResolvedValue(PUBLIC);
    // ...but the connect-time lookup is offered loopback instead.
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    await expect(
      downloadAudio(url, undefined, `http://rebind.test:${internal.port}/api/v1`, true),
    ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

    // A transport without the pinned dispatcher would have connected here.
    expect(internal.requests()).toBe(0);
    expect(dnsMocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('refuses a client endpoint loopback target even with ALLOW_LOCAL_NETWORKS=true', async () => {
    // The operator opt-in is for server-managed providers, never a client BYOK
    // endpoint: `publicOnly` keeps the strict public policy on the download hop.
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const internal = await startLoopback();

    await expect(
      downloadAudio(
        `http://127.0.0.1:${internal.port}/clip.wav`,
        undefined,
        `http://127.0.0.1:${internal.port}/api/v1`,
        true,
      ),
    ).rejects.toThrow(PRIVATE_BLOCK_MESSAGE);

    expect(internal.requests()).toBe(0);
  });

  it('still rejects a non-allowlisted host before any transport or DNS', async () => {
    await expect(
      downloadAudio(
        'https://untrusted.example.com/clip.wav',
        undefined,
        'https://trusted.example.com/api/v1',
        true,
      ),
    ).rejects.toMatchObject({ code: 'QWEN_VC_AUDIO_URL_INVALID' });

    expect(dnsMocks.promisesLookup).not.toHaveBeenCalled();
    expect(dnsMocks.callbackLookup).not.toHaveBeenCalled();
  });

  it('still treats a redirect on the download hop as a hard failure', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const internal = await startLoopback();
    const origin = await startLoopback((_req, res) => {
      res.writeHead(302, { Location: `http://download.test:${internal.port}/final` });
      res.end();
    });
    dnsMocks.promisesLookup.mockResolvedValue(LOOPBACK);
    dnsMocks.callbackLookup.mockImplementation(answerWith(LOOPBACK));

    await expect(
      downloadAudio(
        `http://download.test:${origin.port}/start`,
        undefined,
        `http://download.test:${origin.port}/api/v1`,
        false,
      ),
    ).rejects.toMatchObject({ code: 'QWEN_VC_AUDIO_DOWNLOAD_FAILED' });

    expect(origin.requests()).toBe(1);
    expect(internal.requests()).toBe(0);
  });
});
