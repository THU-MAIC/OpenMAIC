import { describe, expect, it, vi } from 'vitest';

import type { VideoProviderId } from '@/lib/media/types';
import { VIDEO_PROVIDERS, generateVideo, testVideoConnectivity } from '@/lib/media/video-providers';

const adapterMocks = vi.hoisted(() => {
  const connectivity = () => ({ success: true, message: 'ok' });
  return {
    seedance: { generate: vi.fn(), test: vi.fn(connectivity) },
    kling: { generate: vi.fn(), test: vi.fn(connectivity) },
    'minimax-video': { generate: vi.fn(), test: vi.fn(connectivity) },
    'grok-video': { generate: vi.fn(), test: vi.fn(connectivity) },
    happyhorse: { generate: vi.fn(), test: vi.fn(connectivity) },
    'openrouter-video': { generate: vi.fn(), test: vi.fn(connectivity) },
  };
});

vi.mock('@/lib/media/adapters/seedance-adapter', () => ({
  generateWithSeedance: adapterMocks.seedance.generate,
  testSeedanceConnectivity: adapterMocks.seedance.test,
}));
vi.mock('@/lib/media/adapters/kling-adapter', () => ({
  generateWithKling: adapterMocks.kling.generate,
  testKlingConnectivity: adapterMocks.kling.test,
}));
vi.mock('@/lib/media/adapters/minimax-video-adapter', () => ({
  generateWithMiniMaxVideo: adapterMocks['minimax-video'].generate,
  testMiniMaxVideoConnectivity: adapterMocks['minimax-video'].test,
}));
vi.mock('@/lib/media/adapters/grok-video-adapter', () => ({
  generateWithGrokVideo: adapterMocks['grok-video'].generate,
  testGrokVideoConnectivity: adapterMocks['grok-video'].test,
}));
vi.mock('@/lib/media/adapters/happyhorse-adapter', () => ({
  generateWithHappyHorse: adapterMocks.happyhorse.generate,
  testHappyHorseConnectivity: adapterMocks.happyhorse.test,
}));
vi.mock('@/lib/media/adapters/openrouter-video-adapter', () => ({
  generateWithOpenRouterVideo: adapterMocks['openrouter-video'].generate,
  testOpenRouterVideoConnectivity: adapterMocks['openrouter-video'].test,
}));

/** Every catalog id must dispatch to its own adapter in both switches. */
const CATALOG_IDS = Object.keys(VIDEO_PROVIDERS) as VideoProviderId[];

describe('video provider catalog', () => {
  it('keeps the retiring Seedance Lite T2V model selectable until shutdown', () => {
    expect(VIDEO_PROVIDERS.seedance.models).toContainEqual({
      id: 'doubao-seedance-1-0-lite-t2v-250428',
      name: 'Seedance 1.0 Lite T2V',
    });
  });

  it('does not list a selectable provider that has no adapter (sora)', () => {
    // `sora` used to be selectable in the catalog with no connectivity or
    // generation case, so choosing it failed only at execution time. A catalog
    // entry that cannot execute is worse than an absent one.
    expect(CATALOG_IDS).not.toContain('sora');
  });

  it('does not list the retired Veo provider', () => {
    // Google shut down every Veo model the provider listed on 2026-10-22
    // (#1940): with nothing left to select, the entry is removed rather than
    // kept as a provider that cannot generate.
    expect(CATALOG_IDS).not.toContain('veo');
  });

  it.each(CATALOG_IDS)(
    'dispatches %s to its adapter in connectivity and generation',
    async (id) => {
      const mocks = adapterMocks[id];

      await testVideoConnectivity({ providerId: id, apiKey: 'test-key' });
      expect(mocks.test).toHaveBeenCalledTimes(1);

      await generateVideo({ providerId: id, apiKey: 'test-key' }, { prompt: 'a test video' });
      expect(mocks.generate).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the connectivity and generation switches in sync with the catalog', async () => {
    for (const id of CATALOG_IDS) {
      const result = await testVideoConnectivity({ providerId: id, apiKey: 'test-key' });
      // The default switch branch (a catalog entry without an adapter) answers
      // "Unsupported video provider"; a catalog entry must never reach it.
      expect(result.message).not.toMatch(/^Unsupported video provider:/);
    }
  });
});
