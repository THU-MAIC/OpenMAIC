import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetAssetReplacementChannelForTesting,
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

  it('propagates a same-id replacement to a mounted consumer in another realm', async () => {
    // Tab B: a consumer holding a lease, listening on its own channel instance.
    // The module-local observer set is shared in-process, so the peer realm is
    // modelled by a second channel that mirrors what tab B's module would do.
    const refreshedInPeerTab: string[] = [];
    const peerChannel = new BroadcastChannel('maic-asset-replacements');
    peerChannel.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') refreshedInPeerTab.push(event.data);
    };

    // Tab A replaces the bytes behind the same id.
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
