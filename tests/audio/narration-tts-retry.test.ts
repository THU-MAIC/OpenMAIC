import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

const mocks = vi.hoisted(() => ({
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
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: mocks.settingsState,
  },
}));

vi.mock('@/lib/device-storage/database', () => ({
  db: {
    audioFiles: {
      put: mocks.audioPut,
      delete: mocks.audioDelete,
    },
  },
}));

vi.mock('@/lib/media/asset-pool', () => ({
  putAsset: mocks.poolPut,
  replaceAsset: mocks.poolReplace,
  removeAsset: mocks.poolRemove,
}));

vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: mocks.isTTSProviderEnabled,
}));

vi.mock('@/lib/audio/agent-voice', () => ({
  pickNarratorAgent: mocks.pickNarratorAgent,
  resolveAgentVoiceOptions: mocks.resolveAgentVoiceOptions,
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: {
    getState: () => ({
      listAgents: mocks.listAgents,
    }),
  },
}));

vi.mock('sonner', () => ({ toast: { warning: mocks.toastWarning } }));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const retryOptions = {
  maxRetries: 1,
  sleep: async () => undefined,
  random: () => 0,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? 'Too Many Requests' : status === 401 ? 'Unauthorized' : 'OK',
    json: async () => body,
  };
}

describe('narration TTS retries', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.audioPut.mockReset();
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockReset();
    mocks.poolReplace.mockReset().mockResolvedValue(undefined);
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockResolvedValue('ast_audio_allocated');
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsVoiceProviderId: 'server-tts',
      ttsProvidersConfig: {
        'server-tts': {
          apiKey: 'tts-key',
          modelId: 'tts-model',
        },
      },
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

  it('retries transient TTS failures before storing audio', async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    mockFetch
      .mockResolvedValueOnce(jsonResponse(503, { error: 'provider overloaded' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          base64: btoa('audio-data'),
          format: 'wav',
        }),
      );

    const audioId = await generateAndStoreTTS(
      'tts_s2_action_1',
      'Hello class',
      'English',
      undefined,
      retryOptions,
    );

    expect(audioId).toBe('ast_audio_allocated');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mocks.poolPut).toHaveBeenCalledOnce();
    // The local copy is a cache of the pool entry, under the allocated id.
    expect(mocks.audioPut).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ast_audio_allocated',
        format: 'wav',
      }),
    );
  });

  it("narrates with a voice the slot's model can speak", async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    // Marin needs gpt-4o-mini-tts; the slot speaks with tts-1.
    mocks.settingsState.mockReturnValue({
      ...mocks.settingsState(),
      ttsVoiceProviderId: 'openai-tts',
      ttsVoice: 'marin',
    });
    setModelSettingsViewForTests({ tts: { registryId: 'openai-tts', modelId: 'tts-1' } });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: true, base64: btoa('audio'), format: 'wav' }),
    );

    await generateAndStoreTTS('request-model', 'Hello class');
    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(body.ttsVoice).toBe('alloy');

    // On gpt-4o-mini-tts the same voice is kept.
    setModelSettingsViewForTests({ tts: { registryId: 'openai-tts', modelId: 'gpt-4o-mini-tts' } });
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, { success: true, base64: btoa('audio'), format: 'wav' }),
    );
    await generateAndStoreTTS('request-model-2', 'Hello class');
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body)).ttsVoice).toBe('marin');
  });

  it('falls back once from a missing narrator clone to the global voice', async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    mocks.settingsState.mockReturnValue({
      ...mocks.settingsState(),
      ttsVoiceProviderId: 'qwen-tts',
      ttsVoice: 'Cherry',
      ttsProvidersConfig: {
        'qwen-tts': { apiKey: 'tts-key', modelId: 'qwen3-tts-vc-2026-01-22' },
      },
    });
    // The workspace's tts slot resolves to this provider.
    setModelSettingsViewForTests({
      tts: { registryId: 'qwen-tts', modelId: 'qwen3-tts-vc-2026-01-22' },
    });
    mocks.pickNarratorAgent.mockReturnValue({
      id: 'teacher-missing-clone',
      role: 'teacher',
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'deleted-clone-id' },
    });
    mockFetch
      .mockResolvedValueOnce(
        jsonResponse(400, {
          errorCode: 'QWEN_VC_VOICE_NOT_FOUND',
          error: 'The cloned Qwen voice no longer exists.',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, base64: btoa('fallback-audio'), format: 'wav' }),
      );

    await expect(
      generateAndStoreTTS('request-fallback', 'Hello class', undefined, undefined, {
        ...retryOptions,
        maxRetries: 0,
      }),
    ).resolves.toBe('ast_audio_allocated');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(firstBody).toMatchObject({
      ttsVoice: 'deleted-clone-id',
    });
    expect(secondBody).toMatchObject({ ttsVoice: 'Cherry' });
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
  });

  it('reports the allocated id even when the local cache write fails', async () => {
    const { generateAndStoreTTS } = await import('@/lib/audio/narration-tts');
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        base64: btoa('audio-data'),
        format: 'wav',
      }),
    );
    mocks.audioPut.mockRejectedValueOnce(new Error('cache unavailable'));

    // The bytes are in the pool; a failed cache write only costs a re-download.
    await expect(generateAndStoreTTS('request-1', 'Hello class')).resolves.toBe(
      'ast_audio_allocated',
    );
    expect(mocks.poolPut).toHaveBeenCalledOnce();
    expect(mocks.poolRemove).not.toHaveBeenCalled();
  });
});
