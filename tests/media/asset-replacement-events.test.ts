import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssetReplacementChannelForTesting,
  bindAssetReplacementChannel,
  notifyAssetReplaced,
  observeAssetReplacements,
  type AssetReplacementPool,
} from '@/lib/media/asset-replacement-events';

const pool: AssetReplacementPool = {
  resolve: vi.fn(async () => 'blob:refreshed'),
  release: vi.fn(async () => {}),
};

/** Lets the channel's asynchronous delivery settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('asset replacement events', () => {
  afterEach(() => {
    __resetAssetReplacementChannelForTesting();
    vi.clearAllMocks();
  });

  it('notifies observers in the replacing realm', async () => {
    const observed: string[] = [];
    const stop = observeAssetReplacements((ref) => {
      observed.push(ref);
    });

    await notifyAssetReplaced('ast_local', pool);

    expect(observed).toEqual(['ast_local']);
    stop();
  });

  it('receives peer replacements in a realm that never sends one', async () => {
    // A passive tab only renders: it binds the channel when it starts observing,
    // never through the sender path.
    const refreshed: string[] = [];
    const stop = observeAssetReplacements((ref) => {
      refreshed.push(ref);
    });
    bindAssetReplacementChannel(() => pool);

    const peerChannel = new BroadcastChannel('maic-asset-replacements');
    peerChannel.postMessage('ast_from_peer');
    await settle();

    expect(refreshed).toEqual(['ast_from_peer']);
    peerChannel.close();
    stop();
  });

  it('keeps a failing observer from failing the committed replacement', async () => {
    // The durable write has already committed by the time observers run.
    const stopFailing = observeAssetReplacements(() => {
      throw new Error('stale dynamic import');
    });
    const seen: string[] = [];
    const stopHealthy = observeAssetReplacements((ref) => {
      seen.push(ref);
    });

    try {
      await expect(notifyAssetReplaced('ast_committed', pool)).resolves.toBeUndefined();
      expect(seen).toEqual(['ast_committed']);
    } finally {
      stopFailing();
      stopHealthy();
    }
  });

  it('propagates a same-id replacement to a mounted consumer in another realm', async () => {
    // Tab B: a consumer holding a lease, listening on its own channel instance.
    // The module-local observer set is shared in-process, so the peer realm is
    // modelled by a second channel that mirrors what tab B's module would do.
    const refreshedInPeerTab: string[] = [];
    const peerChannel = new BroadcastChannel('maic-asset-replacements');
    peerChannel.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') refreshedInPeerTab.push(event.data);
    };

    // Tab A: its module bound the channel on load, then it replaces the bytes.
    bindAssetReplacementChannel(() => pool);
    await notifyAssetReplaced('ast_shared', pool);
    await settle();

    expect(refreshedInPeerTab).toEqual(['ast_shared']);
    peerChannel.close();
  });

  it('still notifies local observers when the channel is unavailable', async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error - modelling an environment without the API
    delete globalThis.BroadcastChannel;
    const observed: string[] = [];
    const stop = observeAssetReplacements((ref) => {
      observed.push(ref);
    });

    await expect(notifyAssetReplaced('ast_no_channel', pool)).resolves.toBeUndefined();

    expect(observed).toEqual(['ast_no_channel']);
    stop();
    globalThis.BroadcastChannel = original;
  });
});
