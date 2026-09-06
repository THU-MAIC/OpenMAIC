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

const mocks = vi.hoisted(() => ({
  getCurrentModelConfig: vi.fn(),
  settingsState: vi.fn(),
  audioPut: vi.fn(),
  audioDelete: vi.fn(),
  poolPut: vi.fn(),
  poolReplace: vi.fn(),
  poolRemove: vi.fn(),
  isTTSProviderEnabled: vi.fn(),
  pickNarratorAgent: vi.fn(),
  resolveAgentVoiceOptions: vi.fn(),
  listAgents: vi.fn(),
  toastWarning: vi.fn(),
  serverBacked: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));

vi.mock('@/lib/utils/database', () => ({
  db: {
    audioFiles: { put: mocks.audioPut, delete: mocks.audioDelete },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.poolPut,
  replaceAsset: mocks.poolReplace,
  removeAsset: mocks.poolRemove,
}));

vi.mock('@/lib/persistence/media-persistence', () => ({
  isServerBackedMediaPersistence: mocks.serverBacked,
}));

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
    mocks.poolReplace.mockReset().mockResolvedValue(undefined);
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.serverBacked.mockReset().mockReturnValue(true);
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsProviderId: 'server-tts',
      ttsProvidersConfig: { 'server-tts': { apiKey: 'tts-key', modelId: 'tts-model' } },
      ttsVoice: 'narrator',
      ttsSpeed: 1,
    });
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.toastWarning.mockReset();
  });

  it('returns the pool-allocated id rather than the request key', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
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
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValueOnce(ttsResponse());
    mocks.audioPut.mockRejectedValue(new Error('quota exceeded'));

    await expect(generateAndStoreTTS('tts_s2_action_1', 'Hello class')).resolves.toBe(
      'ast_audio_allocated',
    );
  });

  it('replaces the bytes of a clip the caller proved it exclusively owns', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValueOnce(ttsResponse());

    await expect(
      generateAndStoreTTS(
        'tts_request_s2_action_1',
        'Hello again',
        undefined,
        undefined,
        undefined,
        'ast_owned_audio',
      ),
    ).resolves.toBe('ast_owned_audio');

    expect(mocks.poolPut).not.toHaveBeenCalled();
    expect(mocks.poolReplace).toHaveBeenCalledTimes(1);
    expect(mocks.poolReplace.mock.calls[0]![0]).toBe('ast_owned_audio');
  });

  it('reports no reference when the pool refuses the bytes', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValueOnce(ttsResponse());
    mocks.poolPut.mockRejectedValue(new Error('asset store unavailable'));

    await expect(generateAndStoreTTS('tts_s2_action_1', 'Hello class')).rejects.toThrow(
      'asset store unavailable',
    );
    expect(mocks.audioPut).not.toHaveBeenCalled();
  });

  it('reclaims pool bytes when a scene rolls its fresh narration back', async () => {
    const { removeFreshTtsAllocations } = await import('@/lib/hooks/use-scene-generator');

    await removeFreshTtsAllocations(['ast_one', 'ast_two']);

    expect(mocks.poolRemove.mock.calls.map(([id]) => id)).toEqual(['ast_one', 'ast_two']);
    expect(mocks.audioDelete).toHaveBeenCalledTimes(2);
  });

  it('leaves the pool untouched when media persistence is browser-only', async () => {
    mocks.serverBacked.mockReturnValue(false);
    const { generateAndStoreTTS, removeFreshTtsAllocations } =
      await import('@/lib/hooks/use-scene-generator');
    mockFetch.mockResolvedValueOnce(ttsResponse());

    await expect(generateAndStoreTTS('tts_s2_action_1', 'Hello class')).resolves.toBe(
      'tts_s2_action_1',
    );
    await removeFreshTtsAllocations(['tts_s2_action_1']);

    expect(mocks.poolPut).not.toHaveBeenCalled();
    expect(mocks.poolReplace).not.toHaveBeenCalled();
    expect(mocks.poolRemove).not.toHaveBeenCalled();
  });
});
