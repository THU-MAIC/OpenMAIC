/**
 * Provider-returned media URLs are fetched under the strict public policy.
 *
 * Drives the real helper, the real SSRF guard and the real pinned transport.
 * Stubbed: `node:dns` (to split the URL-layer and connect-time answers for
 * rebinding) and, where the test only checks what reaches the transport, a spy
 * on `providerFetch`. The agent-runtime cases run the real persist functions
 * with a fake asset store.
 */
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as providerFetchModule from '@/lib/server/provider-fetch';
import { destroyAudioProviderDispatchersForTests } from '@/lib/server/provider-fetch';
import { fetchProviderResultUrl } from '@/lib/server/provider-result-fetch';
import { UnsafeNetworkTargetError } from '@/lib/server/ssrf-guard';
import { defaultPersistGeneratedImage } from '@/lib/server/agent-runtime/generate-image';
import { defaultPersistGeneratedVideo } from '@/lib/server/agent-runtime/generate-video';
import { answerWith, LOOPBACK_ANSWER, PUBLIC_ANSWER } from '@/tests/helpers/loopback-servers';
import { createFakeAssetStore } from '@/tests/agent-runtime/_fake-asset-store';

const mocks = vi.hoisted(() => ({
  promisesLookup: vi.fn(),
  callbackLookup: vi.fn(),
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
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const MAX = 1024 * 1024;
const originalAllowLocal = process.env.ALLOW_LOCAL_NETWORKS;
let tcpServer: Server | undefined;

describe('fetchProviderResultUrl', () => {
  beforeEach(() => {
    mocks.promisesLookup.mockReset();
    mocks.callbackLookup.mockReset();
    mocks.promisesLookup.mockResolvedValue(PUBLIC_ANSWER);
    mocks.callbackLookup.mockImplementation(answerWith(LOOPBACK_ANSWER));
    destroyAudioProviderDispatchersForTests();
    // The operator opt-in must not widen the policy for provider-returned URLs.
    process.env.ALLOW_LOCAL_NETWORKS = 'true';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    destroyAudioProviderDispatchersForTests();
    if (originalAllowLocal === undefined) delete process.env.ALLOW_LOCAL_NETWORKS;
    else process.env.ALLOW_LOCAL_NETWORKS = originalAllowLocal;
    if (tcpServer) {
      await new Promise<void>((resolve) => tcpServer!.close(() => resolve()));
      tcpServer = undefined;
    }
  });

  it('decodes a data: URL locally with its declared type', async () => {
    const spy = vi.spyOn(providerFetchModule, 'providerFetch');

    const res = await fetchProviderResultUrl(
      `data:video/mp4;base64,${Buffer.from('video-bytes').toString('base64')}`,
      { maxBytes: MAX },
    );

    expect(spy).not.toHaveBeenCalled();
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('video-bytes');
  });

  it('accepts a data: URL exactly at the limit', async () => {
    const payload = Buffer.alloc(10, 1).toString('base64'); // 10 bytes, padded

    const res = await fetchProviderResultUrl(`data:image/png;base64,${payload}`, { maxBytes: 10 });

    expect((await res.arrayBuffer()).byteLength).toBe(10);
  });

  it.each([
    ['base64', `data:image/png;base64,${Buffer.alloc(11).toString('base64')}`],
    ['percent-encoded', `data:text/plain,${'%41'.repeat(11)}`],
  ])('refuses a %s data: URL over the limit before decoding it', async (_kind, url) => {
    const from = vi.spyOn(Buffer, 'from');

    await expect(fetchProviderResultUrl(url, { maxBytes: 10 })).rejects.toThrow(
      'Download failed: data URL exceeds the 10-byte limit',
    );
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ['http://cdn.example.com/x.png', /must use https/],
    ['https://127.0.0.1/x.png', /./],
    ['https://10.0.0.8/x.png', /./],
    ['https://169.254.169.254/latest/meta-data/', /./],
  ])('refuses %s before any request', async (url, message) => {
    const spy = vi.spyOn(providerFetchModule, 'providerFetch');

    await expect(fetchProviderResultUrl(url, { maxBytes: MAX })).rejects.toThrow(message);
    expect(spy).not.toHaveBeenCalled();
  });

  it('hands a public HTTPS URL to the transport under the strict policy', async () => {
    const spy = vi
      .spyOn(providerFetchModule, 'providerFetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));
    const controller = new AbortController();

    await fetchProviderResultUrl('https://cdn.example.com/x.png', {
      signal: controller.signal,
      maxBytes: MAX,
    });

    expect(spy).toHaveBeenCalledWith(
      'https://cdn.example.com/x.png',
      { signal: controller.signal },
      { allowLocalNetworks: false, requireHttps: true },
    );
  });

  it('refuses a host that rebinds to loopback between validation and connect', async () => {
    let connections = 0;
    tcpServer = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => tcpServer!.listen(0, '127.0.0.1', resolve));
    const port = (tcpServer.address() as AddressInfo).port;

    await expect(
      fetchProviderResultUrl(`https://rebind.test:${port}/x.png`, { maxBytes: MAX }),
    ).rejects.toBeInstanceOf(UnsafeNetworkTargetError);
    expect(mocks.callbackLookup).toHaveBeenCalledWith(
      'rebind.test',
      expect.anything(),
      expect.any(Function),
    );
    expect(connections).toBe(0);
  });
});

describe('agent-runtime persistence of provider-returned URLs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = {
    stageId: 'stage-owner',
    ownerId: 'user:test-owner',
    signal: new AbortController().signal,
  };

  it('stores a data: video URL without a network request', async () => {
    const spy = vi.spyOn(providerFetchModule, 'providerFetch');
    const pool = createFakeAssetStore();

    await expect(
      defaultPersistGeneratedVideo(
        {
          ...base,
          result: {
            url: `data:video/mp4;base64,${Buffer.from('inline-video').toString('base64')}`,
            duration: 6,
            width: 1280,
            height: 720,
          },
        },
        pool.store,
      ),
    ).resolves.toMatchObject({ mime: 'video/mp4' });
    expect(pool.puts[0]!.bytes).toEqual(Buffer.from('inline-video'));
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(['http://cdn.example.com/x.png', 'https://10.0.0.8/x.png'])(
    'refuses to download a generated image from %s',
    async (url) => {
      const spy = vi.spyOn(providerFetchModule, 'providerFetch');
      const pool = createFakeAssetStore();

      await expect(
        defaultPersistGeneratedImage({ ...base, result: { url, width: 1, height: 1 } }, pool.store),
      ).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
      expect(pool.puts).toHaveLength(0);
    },
  );
});
