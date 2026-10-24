import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import {
  synthesizeSceneNarration,
  describeNarrationVoice,
} from '@/lib/server/agent-runtime/scene-tts';
import { QwenVoiceCloneError } from '@/lib/audio/qwen-voice-clone';
import { TTSRequestTimeoutError } from '@/lib/audio/tts-providers';
import * as voices from '@/lib/audio/voice-resolver';
import type { Scene, GeneratedAgentConfig } from '@/lib/types/stage';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), persist: vi.fn() }));
vi.mock('@/lib/audio/tts-providers', async (original) => ({
  ...(await original<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: mocks.generate,
}));
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));
const TARGET = 'cosyvoice-v3.5-plus';
function deploy(model = 'qwen3-tts-flash', configured = false) {
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        providers: {
          speech: {
            preset: 'qwen-tts',
            apiKey: 'test',
            models: [model, TARGET],
            ...(configured ? { voices: [{ id: 'operator-voice', name: 'Operator' }] } : {}),
          },
        },
        slots: { tts: `speech:${model}` },
      },
    },
    legacy: false,
    notices: [],
  });
}
function request() {
  return {
    scene: {
      id: 'scene',
      stageId: 'stage',
      actions: [1, 2, 3].map((n) => ({ id: `s${n}`, type: 'speech', text: `Line ${n}` })),
    } as Scene,
    force: false,
    roster: [
      {
        role: 'teacher',
        voiceConfig: { providerId: 'qwen-tts', voiceId: 'cosyvoice-v3.5-plus-unavailable-id' },
      },
    ] as GeneratedAgentConfig[],
  };
}
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', '');
  vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', TARGET);
  deploy();
  mocks.generate
    .mockReset()
    .mockRejectedValueOnce(new QwenVoiceCloneError('QWEN_VC_RECLONE_REQUIRED', 400))
    .mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  mocks.persist.mockReset().mockResolvedValue('media/audio.wav');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setDeploymentConfigForTests();
});
describe('scene clone recovery', () => {
  it.each([false, true])(
    'uses one authorized catalog fallback for all later speech (configured %s)',
    async (configured) => {
      deploy('qwen3-tts-flash', configured);
      const input = request();
      const original = structuredClone(input.roster);
      const summary = await synthesizeSceneNarration(input);
      expect(summary).toMatchObject({
        voice: {
          binding: `qwen-tts::${configured ? 'operator-voice' : 'Cherry'}`,
          source: 'recovery-fallback',
        },
        generated: 3,
        failed: [],
        recovery: {
          reason: 'reclone-required',
          status: 'fallback',
          message: expect.stringMatching(/temporar.*re-upload/i),
        },
      });
      expect(mocks.generate.mock.calls.map(([cfg]) => cfg.voice)).toEqual([
        'cosyvoice-v3.5-plus-unavailable-id',
        ...Array(3).fill(configured ? 'operator-voice' : 'Cherry'),
      ]);
      for (const [cfg] of mocks.generate.mock.calls.slice(1)) {
        expect(cfg.modelId).toBe('qwen3-tts-flash');
        expect(cfg.providerOptions.qwenVoiceClone).not.toBe(true);
      }
      expect(describeNarrationVoice(summary.voice!)).toContain('temporary fallback');
      expect(describeNarrationVoice(summary.voice!)).not.toContain('roster binding');
      expect(input.roster).toEqual(original);
    },
  );
  it.each([false, true])(
    'reports successful audio when a later fallback succeeds: %s',
    async (succeeds) => {
      const audio = { audio: new Uint8Array([1]), format: 'wav' };
      mocks.generate
        .mockReset()
        .mockResolvedValueOnce(audio)
        .mockRejectedValueOnce(new QwenVoiceCloneError('QWEN_VC_VOICE_NOT_FOUND', 404));
      if (succeeds) mocks.generate.mockResolvedValue(audio);
      else mocks.generate.mockRejectedValue(new QwenVoiceCloneError('QWEN_VC_HTTP_ERROR', 502));
      const summary = await synthesizeSceneNarration(request());
      expect(summary.generated).toBe(succeeds ? 3 : 1);
      expect(summary.voice).toMatchObject({
        binding: `qwen-tts::${succeeds ? 'Cherry' : 'cosyvoice-v3.5-plus-unavailable-id'}`,
        source: succeeds ? 'recovery-fallback' : 'roster-teacher',
      });
      if (succeeds)
        expect(describeNarrationVoice(summary.voice!)).toContain(
          'Earlier generated lines used a different voice',
        );
      else expect(describeNarrationVoice(summary.voice!)).not.toContain('Cherry');
    },
  );
  it('records typed failure once and does not start another fallback chain', async () => {
    mocks.generate
      .mockReset()
      .mockRejectedValueOnce(new QwenVoiceCloneError('QWEN_VC_RECLONE_REQUIRED', 400))
      .mockRejectedValue(new QwenVoiceCloneError('QWEN_VC_HTTP_ERROR', 502));
    expect(await synthesizeSceneNarration(request())).toMatchObject({
      generated: 0,
      voice: { binding: 'qwen-tts::cosyvoice-v3.5-plus-unavailable-id', source: 'roster-teacher' },
      failed: ['s1', 's2', 's3'],
      recovery: {
        status: 'failed',
        errorCode: 'QWEN_VC_HTTP_ERROR',
        message: expect.stringContaining('re-upload'),
      },
    });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
  it('preserves the actionable reason when no candidate exists', async () => {
    vi.spyOn(voices, 'voiceAfterUnavailableBinding').mockReturnValue(null);
    expect(await synthesizeSceneNarration(request())).toMatchObject({
      generated: 0,
      failed: ['s1', 's2', 's3'],
      recovery: { status: 'failed', errorCode: 'QWEN_VC_RECLONE_REQUIRED' },
    });
    expect(mocks.generate).toHaveBeenCalledOnce();
  });
  it('does not swallow fallback model authorization errors', async () => {
    deploy(TARGET);
    await expect(synthesizeSceneNarration(request())).rejects.toMatchObject({
      code: 'PROVIDER_DISABLED',
      httpStatus: 403,
    });
    expect(mocks.generate).toHaveBeenCalledOnce();
  });
  it.each(['abort', 'timeout'] as const)(
    'immediately propagates %s during fallback',
    async (kind) => {
      const controller = new AbortController();
      const input = { ...request(), signal: controller.signal };
      const error =
        kind === 'timeout'
          ? new TTSRequestTimeoutError('qwen-tts', 'timed out')
          : new DOMException('aborted', 'AbortError');
      mocks.generate
        .mockReset()
        .mockRejectedValueOnce(new QwenVoiceCloneError('QWEN_VC_RECLONE_REQUIRED', 400))
        .mockImplementationOnce(async () => {
          if (kind === 'abort') controller.abort(error);
          throw error;
        });
      await expect(synthesizeSceneNarration(input)).rejects.toBe(error);
      expect(mocks.generate).toHaveBeenCalledTimes(2);
    },
  );
  it.each([false, true])('propagates the Qwen internal timeout (fallback %s)', async (fallback) => {
    const error = new QwenVoiceCloneError('QWEN_VC_TIMEOUT', 504);
    mocks.generate.mockReset();
    if (fallback)
      mocks.generate.mockRejectedValueOnce(
        new QwenVoiceCloneError('QWEN_VC_RECLONE_REQUIRED', 400),
      );
    mocks.generate.mockRejectedValue(error);
    await expect(synthesizeSceneNarration(request())).rejects.toBe(error);
    expect(mocks.generate).toHaveBeenCalledTimes(fallback ? 2 : 1);
  });
  it('skips existing audio unless forced', async () => {
    const input = request();
    for (const action of input.scene.actions!) Object.assign(action, { audioId: 'existing' });
    expect(await synthesizeSceneNarration(input)).toMatchObject({ generated: 0, skipped: 3 });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(await synthesizeSceneNarration({ ...input, force: true })).toMatchObject({
      generated: 3,
      skipped: 0,
    });
  });
});
