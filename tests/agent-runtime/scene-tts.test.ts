import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  generate: vi.fn(),
  persist: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', () => ({
  resolveTTSModel: vi.fn(() => ''),
  slotTTSModel: vi.fn(() => ''),
}));
vi.mock('@/lib/server/model-config/media', async (original) => ({
  ...(await original<typeof import('@/lib/server/model-config/media')>()),
  serverMediaConnection: (...args: unknown[]) => mocks.providers(...args),
}));

vi.mock('@/lib/audio/tts-providers', async (original) => ({
  ...(await original<typeof import('@/lib/audio/tts-providers')>()),
  generateTTS: (...args: unknown[]) => mocks.generate(...args),
}));

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

import {
  describeNarrationVoice,
  synthesizeSceneNarration,
} from '@/lib/server/agent-runtime/scene-tts';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import type { Scene } from '@/lib/types/stage';

const scene = {
  id: 'scene-a',
  stageId: 'stage-a',
  order: 1,
  title: 'A',
  type: 'slide',
  content: { type: 'slide' },
  actions: [{ id: 'speech-a', type: 'speech', text: 'Hello' }],
} as Scene;

describe('scene TTS capability routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('synthesizes nothing when the tts slot is turned off', async () => {
    mocks.providers.mockResolvedValue('off');
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      ownerId: 'user:alice',
    });
    expect(mocks.providers).toHaveBeenCalledWith('tts', 'user:alice');
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('stores generated narration bytes in classroom media', async () => {
    mocks.providers.mockResolvedValue({
      providerId: 'configured-tts',
      managed: true,
      userEndpoint: false,
      origin: 'configuration',
    });
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'mp3' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3');
    const target = structuredClone(scene);
    const summary = await synthesizeSceneNarration({ scene: target, force: false });
    expect(summary).toMatchObject({ available: true, changed: true, generated: 1 });
    // The durable reference is the RELATIVE classroom-media path (origin-
    // independent), stamped on both `audioId` and the legacy `audioUrl` pair
    // the browser's narration consumers resolve (timeline status/preview,
    // playback fetch, exports) — so agent-generated narration is voiced and
    // playable on any deployment origin.
    expect(target.actions?.[0]).toMatchObject({
      audioId: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
      audioUrl: '/api/classroom-media/stage-a/media/tts-speech-a-abc123.mp3',
    });
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ stageId: 'stage-a', mime: 'audio/mpeg' }),
    );
  });

  describe('voice reporting', () => {
    const slot = {
      providerId: 'configured-tts',
      managed: true,
      userEndpoint: false,
      origin: 'configuration',
      options: { defaultVoice: 'slot-default' },
    };
    const agent = (
      role: GeneratedAgentConfig['role'],
      name: string,
      voiceConfig?: { providerId: string; voiceId: string },
    ) =>
      ({
        id: name,
        name,
        role,
        persona: '',
        ...(voiceConfig ? { voiceConfig } : {}),
      }) as GeneratedAgentConfig;

    beforeEach(() => {
      mocks.providers.mockResolvedValue(slot);
      mocks.generate.mockResolvedValue({ audio: new Uint8Array([1]), format: 'mp3' });
      mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts.mp3');
    });

    it("reports the teacher's roster binding when it belongs to the slot provider", async () => {
      const summary = await synthesizeSceneNarration({
        scene: structuredClone(scene),
        force: true,
        roster: [
          agent('teacher', 'Ms. Lin', { providerId: 'configured-tts', voiceId: 'warm' }),
          agent('student', 'Sam', { providerId: 'configured-tts', voiceId: 'bright' }),
        ],
      });
      expect(mocks.generate.mock.calls[0]![0]).toMatchObject({ voice: 'warm' });
      expect(summary.voice).toEqual({
        binding: 'configured-tts::warm',
        source: 'roster-teacher',
        teacher: 'Ms. Lin',
      });
      expect(describeNarrationVoice(summary.voice!)).toBe(
        'Voice: configured-tts::warm (teacher "Ms. Lin"\'s roster binding).',
      );
    });

    it('says when a teacher bound to another provider falls back to the default voice', async () => {
      const summary = await synthesizeSceneNarration({
        scene: structuredClone(scene),
        force: true,
        roster: [
          agent('teacher', 'Ms. Lin', { providerId: 'other-tts', voiceId: 'warm' }),
          agent('student', 'Sam'),
        ],
      });
      const voice = mocks.generate.mock.calls[0]![0].voice as string;
      expect(summary.voice).toEqual({
        binding: `configured-tts::${voice}`,
        source: 'provider-default',
        teacher: 'Ms. Lin',
        fallbackReason: 'teacher-bound-to-other-provider',
      });
      expect(describeNarrationVoice(summary.voice!)).toContain(
        'provider default; teacher "Ms. Lin" is bound to a voice of another provider',
      );
    });

    it('says when there is no teacher to take a voice from', async () => {
      const summary = await synthesizeSceneNarration({
        scene: structuredClone(scene),
        force: true,
      });
      expect(summary.voice).toMatchObject({
        source: 'provider-default',
        fallbackReason: 'no-teacher',
      });
      expect(describeNarrationVoice(summary.voice!)).toContain('the roster has no teacher');
    });
  });
});
