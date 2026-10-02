/**
 * Narration under server-backed persistence.
 *
 * The speech action's `audioId` is the reference a shared document carries, so
 * it must name pool-allocated audio rather than a key that only means something
 * inside the browser that produced it. Bytes reach the pool before the id is
 * returned, so a caller can never stamp an action with narration that was not
 * stored.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

const mocks = vi.hoisted(() => ({
  settingsState: vi.fn(),
  audioPut: vi.fn(),
  audioDelete: vi.fn(),
  poolPut: vi.fn(),
  poolRemove: vi.fn(),
  isTTSProviderEnabled: vi.fn(),
  pickNarratorAgent: vi.fn(),
  resolveAgentVoiceOptions: vi.fn(),
  listAgents: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));

vi.mock('@/lib/device-storage/database', () => ({
  db: {
    audioFiles: { put: mocks.audioPut, delete: mocks.audioDelete },
  },
}));

/**
 * The pool is doubled at the store rather than at `putAsset`, so the real
 * wrapper runs: retiring this course's "store is full" note on a successful
 * write lives there now, and a suite that replaced `putAsset` wholesale would
 * be asserting that behaviour against its own double.
 */
vi.mock('@/lib/media/asset-pool-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/asset-pool-config')>();
  return {
    ...actual,
    resolveConfiguredAssetPoolStore: () =>
      ({ put: mocks.poolPut }) as unknown as import('@/lib/media/asset-pool-config').AssetPoolStore,
  };
});

vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: mocks.isTTSProviderEnabled,
}));

vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: mocks.pickNarratorAgent,
  resolveAgentVoiceOptions: mocks.resolveAgentVoiceOptions,
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: mocks.listAgents }) },
}));

vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function ttsResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ success: true, base64: btoa('audio-data'), format: 'wav' }),
  };
}

describe('server-backed narration storage', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockReset().mockResolvedValue('ast_audio_allocated');
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsVoiceProviderId: 'server-tts',
      ttsProvidersConfig: { 'server-tts': { apiKey: 'tts-key', modelId: 'tts-model' } },
      ttsVoice: 'narrator',
      ttsSpeed: 1,
    });
    // The workspace's tts slot resolves to this provider.
    setModelSettingsViewForTests({ tts: { registryId: 'server-tts', modelId: 'tts-model' } });
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.toastWarning.mockReset();
  });

  it('returns the pool-allocated id rather than the request key', async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    mockFetch.mockResolvedValueOnce(ttsResponse());

    await expect(generateAndStoreTTS('tts_s2_action_1', 'Hello class')).resolves.toBe(
      'ast_audio_allocated',
    );

    expect(mocks.poolPut).toHaveBeenCalledTimes(1);
    const [blob, meta] = mocks.poolPut.mock.calls[0] as [Blob, Record<string, unknown>];
    await expect(blob.text()).resolves.toBe('audio-data');
    expect(meta.contentType).toBe('audio/wav');
    // The local table is a cache keyed by the allocated id, never the identity.
    expect(mocks.audioPut).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ast_audio_allocated', format: 'wav' }),
    );
  });

  it('keeps a cache write failure from losing narration the pool already holds', async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    mockFetch.mockResolvedValueOnce(ttsResponse());
    mocks.audioPut.mockRejectedValue(new Error('quota exceeded'));

    await expect(generateAndStoreTTS('tts_s2_action_1', 'Hello class')).resolves.toBe(
      'ast_audio_allocated',
    );
  });

  // Regeneration forks. Replacing bytes behind a live id needs proof that no
  // other document holds it, and no browser can have that proof, so there is no
  // way to hand an existing id in at all. The superseded clip is left for the
  // server-side reclamation rather than deleted here, where nothing has yet
  // observed the new id reaching a durable document: the save that writes the
  // new id is the write that stops naming the old one, and releasing it is the
  // server's job from there.
  it('allocates a fresh id for every clip and removes nothing', async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    mockFetch.mockResolvedValueOnce(ttsResponse());

    await expect(
      generateAndStoreTTS(
        'tts_request_s2_action_1',
        'Hello again',
        undefined,
        undefined,
        undefined,
        'course-1',
      ),
    ).resolves.toBe('ast_audio_allocated');

    expect(mocks.poolPut).toHaveBeenCalledTimes(1);
    expect(mocks.poolRemove).not.toHaveBeenCalled();
  });

  // Storing narration failed, not synthesizing it: the line is left unvoiced
  // and retryable, as an image that cannot be stored leaves its slide.
  it('leaves the line unvoiced rather than failing when the pool refuses', async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    mockFetch.mockResolvedValueOnce(ttsResponse());
    mocks.poolPut.mockRejectedValue(new Error('asset store unavailable'));

    await expect(generateAndStoreTTS('tts_s2_action_1', 'Hello class')).resolves.toBeNull();
    expect(mocks.audioPut).not.toHaveBeenCalled();
  });
});
