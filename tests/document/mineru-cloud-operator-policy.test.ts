/**
 * Operator-policy coverage for the MinerU Cloud API root, over the real
 * transport.
 *
 * The API root is a configured endpoint, so a self-hoster with
 * `ALLOW_LOCAL_NETWORKS=true` must be able to point it at a local MinerU
 * service. `mineru-cloud.test.ts` asserts the policy wiring with a stubbed
 * transport; this file drives the real redirect-validating, DNS-pinning
 * transport against a loopback mock, proving that:
 *
 *  - with the operator opt-in enabled the first hop actually reaches the
 *    client-supplied local API root, while a response-supplied private upload
 *    URL is still refused under the strict public policy and never requested.
 *
 * The complementary "opt-in unset" case is a route-level decision: the route
 * rejects the local baseUrl with `validateUrlForSSRF` before the parser runs,
 * which `extract-document-route.test.ts` covers.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

interface MockApiRoot {
  port: number;
  requests: string[];
}

const servers: Server[] = [];
const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

/** A loopback MinerU v4 control plane that answers batch creation with `uploadUrl`. */
async function startMockApiRoot(uploadUrl: string): Promise<MockApiRoot> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.method === 'POST' && req.url?.endsWith('/file-urls/batch')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ code: 0, msg: 'ok', data: { batch_id: 'b1', file_urls: [uploadUrl] } }),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 1, msg: 'not found', data: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, requests };
}

describe('parseWithMinerUCloud — operator policy on a local API root', () => {
  beforeEach(() => {
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

  it('reaches a local API root under ALLOW_LOCAL_NETWORKS=true but refuses its private upload URL', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const origin = await startMockApiRoot('https://10.1.2.3/upload/lesson.pdf');

    await expect(
      parseWithMinerUCloud(
        {
          providerId: 'mineru-cloud',
          apiKey: 'cloud-key',
          baseUrl: `http://127.0.0.1:${origin.port}/api/v4`,
        },
        Buffer.from('bytes'),
        'lesson.pdf',
      ),
    ).rejects.toThrow(/not allowed/);

    // The first hop reached the loopback mock under the operator policy...
    expect(origin.requests).toEqual(['POST /api/v4/file-urls/batch']);
    // ...while the private response-supplied upload URL was never requested.
    expect(origin.requests.some((request) => request.includes('/upload'))).toBe(false);
  });
});
