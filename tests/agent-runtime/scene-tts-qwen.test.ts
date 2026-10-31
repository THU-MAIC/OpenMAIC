import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import {
  synthesizeSceneNarration,
  formatTtsFailureTally,
} from '@/lib/server/agent-runtime/scene-tts';
import type { Scene, GeneratedAgentConfig } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn(), persist: vi.fn() }));
vi.mock('undici', async (original) => ({
  ...(await original<typeof import('undici')>()),
  fetch: mocks.fetch,
}));
vi.mock('node:dns', async (original) => {
  const actual = await original<typeof import('node:dns')>();
  return { ...actual, promises: { ...actual.promises, lookup: mocks.lookup } };
});
vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

const TARGET = 'cosyvoice-v3.5-flash';
function deployment(models = ['qwen3-tts-flash', TARGET]) {
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        providers: {
          speech: { preset: 'qwen-tts', apiKey: 'test-key', models },
        },
        slots: { tts: 'speech:qwen3-tts-flash' },
      },
    },
    legacy: false,
    notices: [],
  });
}
function input(voiceId: string) {
  return {
    scene: {
      id: 'scene',
      stageId: 'stage',
      order: 0,
      title: 'Test',
      type: 'slide',
      content: { type: 'slide' },
      actions: [{ id: 'speech', type: 'speech', text: 'Hello' }],
    } as Scene,
    force: false,
    roster: [
      { role: 'teacher', voiceConfig: { providerId: 'qwen-tts', voiceId } },
    ] as GeneratedAgentConfig[],
  };
}

describe('agent scene narration with Qwen cloned voices', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('TTS_QWEN_VOICE_CLONE_MODEL', TARGET);
    deployment();
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mocks.persist.mockReset().mockResolvedValue('media/tts-speech.wav');
    mocks.fetch
      .mockReset()
      .mockResolvedValueOnce(
        Response.json({
          output: {
            audio: { url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav' },
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([82, 73, 70, 70]), {
          headers: { 'content-type': 'audio/wav' },
        }),
      );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setDeploymentConfigForTests();
    vi.restoreAllMocks();
  });

  it('synthesizes and persists using the authorized clone target override', async () => {
    const request = input(`${TARGET}-teacher-id`);
    await expect(synthesizeSceneNarration(request)).resolves.toMatchObject({
      generated: 1,
      failed: [],
    });
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).model).toBe(TARGET);
    expect(request.scene.actions?.[0]).toMatchObject({
      audioId: 'media/tts-speech.wav',
      audioUrl: 'media/tts-speech.wav',
    });
    expect(mocks.persist).toHaveBeenCalledOnce();
  });

  it.each(['cosyvoice-v3.5-plus-other-target', 'qwen-tts-vc-retired-id'])(
    'reports reclone guidance for %s without synthesizing another voice',
    async (voice) => {
      deployment(['qwen3-tts-flash']);
      const request = input(voice);
      request.scene.actions!.push({ id: 'second', type: 'speech', text: 'Next' });
      const sleep = vi.fn(async () => undefined);
      const result = await synthesizeSceneNarration({ ...request, sleep });
      expect(result).toMatchObject({
        generated: 0,
        failed: [
          { id: 'speech', reason: 'QWEN_VC_RECLONE_REQUIRED' },
          { id: 'second', reason: 'QWEN_VC_RECLONE_REQUIRED' },
        ],
      });
      expect(formatTtsFailureTally(result.failed)).toContain('Re-upload');
      expect(sleep).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.persist).not.toHaveBeenCalled();
    },
  );

  it('refuses an unlisted clone target before calling the provider', async () => {
    deployment(['qwen3-tts-flash']);
    await expect(synthesizeSceneNarration(input(`${TARGET}-teacher-id`))).rejects.toMatchObject({
      code: 'PROVIDER_DISABLED',
      httpStatus: 403,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
