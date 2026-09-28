/**
 * A server-managed MinerU Cloud API root may be on a local network without
 * ALLOW_LOCAL_NETWORKS, but a redirect it answers with is still judged by the
 * operator policy. Drives the real parser and the real pinned transport against
 * loopback servers; `node:dns` is stubbed so a hop hostname can answer the
 * URL-layer guard and the connect-time lookup differently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseWithMinerUCloud } from '@/lib/pdf/mineru-cloud';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import {
  answerWith,
  closeLoopbackServers,
  LOOPBACK_ANSWER,
  PUBLIC_ANSWER,
  startLoopback,
  type LoopbackServer,
} from '@/tests/helpers/loopback-servers';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    lookup: (...args: unknown[]) => mocks.callbackLookup(...args),
    promises: { ...actual.promises, lookup: mocks.promisesLookup },
  };
});

const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;

/** A MinerU control plane whose batch endpoint answers with a private upload URL. */
function startControlPlane(): Promise<LoopbackServer> {
  return startLoopback((req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/file-urls/batch')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 0,
          msg: 'ok',
          data: { batch_id: 'b1', file_urls: ['https://10.1.2.3/upload/lesson.pdf'] },
        }),
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}

/** An API root that redirects every request to `target`. */
function startRedirectingRoot(target: string): Promise<LoopbackServer> {
  return startLoopback((req, res) => {
    res.writeHead(307, { Location: `${target}${req.url ?? ''}` });
    res.end();
  });
}

function parseManaged(baseUrl: string) {
  return parseWithMinerUCloud(
    { providerId: 'mineru-cloud', apiKey: 'cloud-key', baseUrl, managed: true },
    Buffer.from('bytes'),
    'lesson.pdf',
  );
}

describe('parseWithMinerUCloud — server-managed API root', () => {
  beforeEach(() => {
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    destroyAudioProviderDispatchersForTests();
  });

  afterEach(async () => {
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    await closeLoopbackServers();
  });

  it('reaches a local managed root without ALLOW_LOCAL_NETWORKS', async () => {
    const root = await startControlPlane();

    // The batch call succeeds; the parse then stops at the private upload URL.
    await expect(parseManaged(`${root.origin}/api/v4`)).rejects.toThrow(/not allowed/);

    expect(root.lastUrl()).toBe('/api/v4/file-urls/batch');
    expect(root.requests()).toBe(1);
  });

  it('refuses a redirect from a managed root to a private address without the opt-in', async () => {
    const root = await startRedirectingRoot('http://10.1.2.3:8080');

    await expect(parseManaged(`${root.origin}/api/v4`)).rejects.toThrow(/not allowed/);

    expect(root.requests()).toBe(1);
  });

  it('pins a redirect hop from a managed root under the operator policy', async () => {
    const target = await startControlPlane();
    // The hop host passes the URL-layer guard (public answer) but resolves to
    // loopback at connect time: the hop's pinned lookup must refuse it.
    const root = await startRedirectingRoot(`http://hop.test:${target.port}`);

    await expect(parseManaged(`${root.origin}/api/v4`)).rejects.toThrow(/not allowed/);

    expect(root.requests()).toBe(1);
    expect(target.requests()).toBe(0);
    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'hop.test',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('follows a redirect from a managed root to a local address under ALLOW_LOCAL_NETWORKS', async () => {
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
    const target = await startControlPlane();
    const root = await startRedirectingRoot(target.origin);

    await expect(parseManaged(`${root.origin}/api/v4`)).rejects.toThrow(/not allowed/);

    expect(root.requests()).toBe(1);
    expect(target.lastUrl()).toBe('/api/v4/file-urls/batch');
  });
});
