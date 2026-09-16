import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  baseUrl: vi.fn(),
  model: vi.fn(),
  generate: vi.fn(),
  persist: vi.fn(),
  voiceId: vi.fn(),
  getAdapter: vi.fn(),
  adapter: {
    supportsRegistration: vi.fn(),
    voiceExists: vi.fn(),
    bootstrapReferenceClip: vi.fn(),
    registerVoice: vi.fn(),
  },
}));

vi.mock('@/lib/server/provider-config', () => ({
  getServerTTSProviders: mocks.providers,
  resolveTTSApiKey: vi.fn(() => ''),
  resolveTTSBaseUrl: mocks.baseUrl,
  resolveTTSModel: mocks.model,
}));

vi.mock('@/lib/audio/tts-providers', () => ({ generateTTS: mocks.generate }));
vi.mock('@/lib/audio/voice-design', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audio/voice-design')>()),
  getDeterministicVoiceId: mocks.voiceId,
}));
vi.mock('@/lib/audio/voice-registration', () => ({
  getVoiceRegistrationAdapter: mocks.getAdapter,
}));

vi.mock('@/lib/server/classroom-media-bytes', () => ({
  persistClassroomMediaBytes: mocks.persist,
}));

import { synthesizeSceneNarration } from '@/lib/server/agent-runtime/scene-tts';
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.baseUrl.mockReturnValue(undefined);
    mocks.model.mockReturnValue('');
    mocks.getAdapter.mockReturnValue(undefined);
  });

  it('honors the server capability force-off before synthesis', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': { disabled: true } });
    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
    });
    expect(summary).toMatchObject({ available: false, changed: false });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it('stores generated narration bytes in classroom media', async () => {
    mocks.providers.mockReturnValue({ 'configured-tts': {} });
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

  it('registers and reuses VoxCPM Auto Voice from the server-side roster', async () => {
    mocks.providers.mockReturnValue({ 'voxcpm-tts': {} });
    mocks.baseUrl.mockReturnValue('http://voxcpm.test/v1');
    mocks.model.mockReturnValue('voxcpm2');
    mocks.voiceId.mockResolvedValue('auto-stable-voice');
    mocks.getAdapter.mockReturnValue(mocks.adapter);
    mocks.adapter.supportsRegistration.mockReturnValue(true);
    mocks.adapter.voiceExists.mockResolvedValue(false);
    mocks.adapter.bootstrapReferenceClip.mockResolvedValue({
      referenceAudioBase64: 'UklGRg==',
      mimeType: 'audio/wav',
    });
    mocks.adapter.registerVoice.mockResolvedValue('auto-stable-voice');
    mocks.generate.mockResolvedValue({ audio: new Uint8Array([1, 2]), format: 'wav' });
    mocks.persist.mockResolvedValue('/api/classroom-media/stage-a/media/tts-speech-a.wav');

    const summary = await synthesizeSceneNarration({
      scene: structuredClone(scene),
      force: false,
      roster: [
        {
          id: 'teacher',
          name: 'Teacher',
          role: 'teacher',
          persona: 'patient mentor',
          avatar: '',
          color: '',
          priority: 10,
          voiceConfig: { providerId: 'voxcpm-tts', voiceId: 'voxcpm:auto' },
          voiceDesign: {
            identity: 'adult teacher',
            texture: 'clear and warm',
            delivery: 'calm and steady',
          },
        },
      ],
    });

    expect(summary).toMatchObject({ changed: true, generated: 1, failed: [] });
    expect(mocks.adapter.registerVoice).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://voxcpm.test/v1', model: 'voxcpm2' }),
      expect.objectContaining({ voiceId: 'auto-stable-voice' }),
      undefined,
    );
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: 'voxcpm:auto',
        providerOptions: { registeredVoiceId: 'auto-stable-voice' },
      }),
      'Hello',
    );
  });
});
