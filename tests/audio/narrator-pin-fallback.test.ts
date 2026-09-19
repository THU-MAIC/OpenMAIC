/**
 * The narrator pin (bound == global) must never defeat the unavailable-binding
 * fallback machinery (review finding 2a):
 *
 * - `resolveNarratorVoiceForGeneration` refuses to pin a voice whose provider is
 *   unusable, so agent-profile generation never pins a ghost/deleted voice.
 * - `generateAndStoreTTS` treats bound == global on QWEN_VC_VOICE_NOT_FOUND and
 *   on a disabled provider as "fall back to the deterministic enabled-provider
 *   pick" with a single non-fatal notice, instead of throwing or silently
 *   skipping narration.
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
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: mocks.settingsState,
  },
}));

vi.mock('@/lib/utils/database', () => ({
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

import { resolveNarratorVoiceForGeneration } from '@/lib/audio/voice-resolver';
import { QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';
import { clearUnavailableVoiceBindingsForTests } from '@/lib/audio/unavailable-voice-bindings';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 400 ? 'Bad Request' : 'OK',
    json: async () => body,
  };
}

describe('resolveNarratorVoiceForGeneration — unusable global voice is not pinned', () => {
  it('returns undefined when the provider is disabled/unconfigured', () => {
    mocks.isTTSProviderEnabled.mockReturnValue(false);
    expect(
      resolveNarratorVoiceForGeneration('qwen-tts', 'clone-ghost', {
        apiKey: '',
      }),
    ).toBeUndefined();
    expect(resolveNarratorVoiceForGeneration('qwen-tts', 'clone-ghost', undefined)).toBeUndefined();
  });

  it('returns undefined when no voice is selected', () => {
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    expect(resolveNarratorVoiceForGeneration('qwen-tts', undefined, undefined)).toBeUndefined();
    expect(resolveNarratorVoiceForGeneration('qwen-tts', '   ', undefined)).toBeUndefined();
  });

  it('pins the narrator when the provider is enabled, carrying the clone model', () => {
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    expect(
      resolveNarratorVoiceForGeneration('qwen-tts', 'clone-1', {
        apiKey: 'key',
        modelId: 'qwen3-tts-vc-2026-01-22',
      }),
    ).toEqual({
      providerId: 'qwen-tts',
      modelId: QWEN_TTS_VOICE_CLONE_MODEL,
      voiceId: 'clone-1',
    });
  });
});

describe('generateAndStoreTTS — pinned narrator fallback (bound == global)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockReset().mockResolvedValue('ast_audio_allocated');
    mocks.poolReplace.mockReset().mockResolvedValue(undefined);
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.toastWarning.mockReset();
    clearUnavailableVoiceBindingsForTests();
  });

  it('falls back with a notice when the pinned ghost clone is missing (bound == global)', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mocks.settingsState.mockReturnValue({
      ttsProviderId: 'qwen-tts',
      ttsProvidersConfig: {
        'qwen-tts': { apiKey: 'tts-key', modelId: QWEN_TTS_VOICE_CLONE_MODEL },
      },
      ttsVoice: 'clone-ghost',
      ttsSpeed: 1,
    });
    // Everything enabled → the deterministic pick is the first enabled provider
    // in canonical order: openai-tts / 'marin'.
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue({
      id: 'teacher-pinned',
      role: 'teacher',
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'clone-ghost' },
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

    await expect(generateAndStoreTTS('request-pinned-ghost', 'Hello class')).resolves.toBe(
      'request-pinned-ghost',
    );

    // The broken clone was attempted, then the deterministic enabled pick was
    // used instead of throwing or silently skipping.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(firstBody).toMatchObject({
      ttsVoice: 'clone-ghost',
      ttsModelId: QWEN_TTS_VOICE_CLONE_MODEL,
    });
    expect(secondBody).toMatchObject({ ttsVoice: 'marin' });
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
  });

  it('falls back to the enabled provider instead of silently skipping when the pinned provider is disabled', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mocks.settingsState.mockReturnValue({
      ttsProviderId: 'qwen-tts',
      ttsProvidersConfig: {
        'qwen-tts': { apiKey: '', modelId: QWEN_TTS_VOICE_CLONE_MODEL },
      },
      ttsVoice: 'clone-pinned',
      ttsSpeed: 1,
    });
    // qwen unconfigured/disabled; openai enabled → deterministic pick = openai/marin.
    mocks.isTTSProviderEnabled.mockImplementation(
      (providerId: string) => providerId === 'openai-tts',
    );
    mocks.pickNarratorAgent.mockReturnValue({
      id: 'teacher-pinned',
      role: 'teacher',
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'clone-pinned' },
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, { success: true, base64: btoa('enabled-provider-audio'), format: 'wav' }),
    );

    await expect(generateAndStoreTTS('request-pinned-disabled', 'Hello class')).resolves.toBe(
      'request-pinned-disabled',
    );

    // The unusable pinned voice was never sent; narration used the enabled pick.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ ttsVoice: 'marin' });
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
  });
});

describe('generateAndStoreTTS — bound clone dead, global clone dead (review finding)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.audioPut.mockReset().mockResolvedValue(undefined);
    mocks.audioDelete.mockReset().mockResolvedValue(undefined);
    mocks.poolPut.mockReset().mockResolvedValue('ast_audio_allocated');
    mocks.poolReplace.mockReset().mockResolvedValue(undefined);
    mocks.poolRemove.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.pickNarratorAgent.mockReturnValue(undefined);
    mocks.resolveAgentVoiceOptions.mockResolvedValue({});
    mocks.listAgents.mockReturnValue([]);
    mocks.toastWarning.mockReset();
    clearUnavailableVoiceBindingsForTests();
  });

  it('rejects after exactly 2 attempts when the bound clone differs from the global clone and both are missing', async () => {
    const { generateAndStoreTTS } = await import('@/lib/hooks/use-scene-generator');
    mocks.settingsState.mockReturnValue({
      ttsProviderId: 'qwen-tts',
      ttsProvidersConfig: {
        'qwen-tts': { apiKey: 'tts-key', modelId: QWEN_TTS_VOICE_CLONE_MODEL },
      },
      ttsVoice: 'clone-global-dead',
      ttsSpeed: 1,
    });
    // Bound voice differs from the global voice; every synthesis is missing.
    mocks.isTTSProviderEnabled.mockReturnValue(true);
    mocks.pickNarratorAgent.mockReturnValue({
      id: 'teacher-bound-dead',
      role: 'teacher',
      voiceConfig: { providerId: 'qwen-tts', voiceId: 'clone-bound-dead' },
    });
    mockFetch.mockResolvedValue(
      jsonResponse(400, {
        errorCode: 'QWEN_VC_VOICE_NOT_FOUND',
        error: 'The cloned Qwen voice no longer exists.',
      }),
    );

    await expect(generateAndStoreTTS('request-bound-dead', 'Hello class')).rejects.toThrow(
      /no longer exists/,
    );

    // Bound attempt, then the global fallback attempt — then it stops. The
    // retry is bounded to a single fallback hop: with both clones dead it must
    // NOT recurse on the same dead global voice and hot-loop /api/generate/tts.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body));
    expect(firstBody).toMatchObject({
      ttsVoice: 'clone-bound-dead',
      ttsModelId: QWEN_TTS_VOICE_CLONE_MODEL,
    });
    expect(secondBody).toMatchObject({
      ttsVoice: 'clone-global-dead',
      ttsModelId: QWEN_TTS_VOICE_CLONE_MODEL,
    });
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
  });
});
