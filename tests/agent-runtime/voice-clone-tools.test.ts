/**
 * Voice-cloning agent tools: `clip_audio` and `register_voice`.
 *
 * `register_voice` is exercised through a FAKE registration adapter behind the
 * provider-neutral seam (mock of `getVoiceRegistrationAdapter` for a synthetic
 * provider id), proving the tool has no vendor coupling: it only ever sees
 * `supportsRegistration` / `resolveRegistrationModel` / `registerVoice`.
 * The capability gate is pinned from both sides — the tool is absent when no
 * served provider's adapter supports registration, and present (and working)
 * when one does.
 *
 * `clip_audio` pins the session-scoped material reads (a foreign material id
 * reads as absent; a foreign asset id resolves as unavailable), the duration
 * bounds, and the 24 kHz mono PCM WAV output contract stored back as an
 * `audio-track` material.
 */
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSessionMaterial } from '@openmaic/storage';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { VoiceRegistrationAdapter } from '@/lib/audio/voice-registration';

import {
  buildVoiceCloneTools,
  VOICE_CLONE_TOOL_NAMES,
} from '@/lib/server/agent-runtime/voice-clone-tools';

// The CI unit-test runner has no ffmpeg; only the one end-to-end clip test
// below needs the real binary, so it is skipped there and still runs locally.
const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error === undefined;

const mocks = vi.hoisted(() => ({
  enabledServerTTSProviderIds: vi.fn(),
  resolveTTSApiKey: vi.fn(),
  resolveTTSBaseUrl: vi.fn(),
  getVoiceRegistrationAdapter: vi.fn(),
}));

vi.mock('@/lib/server/provider-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/provider-config')>();
  return {
    ...actual,
    enabledServerTTSProviderIds: mocks.enabledServerTTSProviderIds,
    resolveTTSApiKey: mocks.resolveTTSApiKey,
    resolveTTSBaseUrl: mocks.resolveTTSBaseUrl,
  };
});

vi.mock('@/lib/audio/voice-registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/voice-registration')>();
  return {
    ...actual,
    getVoiceRegistrationAdapter: mocks.getVoiceRegistrationAdapter,
  };
});

/** Pure-JS stereo 48 kHz PCM16 sine WAV, so fixture setup never needs ffmpeg.
 * Stereo + 48 kHz is deliberate: the clip tool must downmix and resample it. */
function synthesizeStereoWav(seconds: number, sampleRate = 48_000): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const dataBytes = frames * 2 * 2; // 2 channels × 16-bit
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(2, 22); // stereo
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2 * 2, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12_000);
    wav.writeInt16LE(sample, 44 + i * 4);
    wav.writeInt16LE(sample, 44 + i * 4 + 2);
  }
  return wav;
}

/** A 24 kHz mono PCM16 WAV — the exact clip contract the tools enforce. */
function synthesizeVoiceCloneWav(seconds = 2): Buffer {
  const sampleRate = 24_000;
  const frames = Math.round(seconds * sampleRate);
  const dataBytes = frames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function material(overrides: Partial<AgentSessionMaterial> = {}): AgentSessionMaterial {
  return {
    id: 'mat_clip',
    sessionId: 'ses_1',
    kind: 'audio-track',
    title: 'clip',
    sourceUrl: null,
    textAssetId: null,
    rawAssetId: 'ast_clip',
    textChars: 0,
    derivedFrom: null,
    extraction: { status: 'done', attempts: 0 },
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function fakeAdapter(
  overrides: Partial<VoiceRegistrationAdapter> = {},
): VoiceRegistrationAdapter & { registerVoice: ReturnType<typeof vi.fn> } {
  const adapter = {
    supportsRegistration: vi.fn(() => true),
    supportsBootstrapReferenceClip: false,
    resolveRegistrationModel: vi.fn(() => 'fake-model'),
    voiceExists: vi.fn(async () => false),
    registerVoice: vi.fn(async (_cfg, params) => `voice-${params.voiceId}`),
    bootstrapReferenceClip: async () => {
      throw new Error('fake adapter cannot bootstrap');
    },
    ...overrides,
  };
  return adapter as VoiceRegistrationAdapter & { registerVoice: ReturnType<typeof vi.fn> };
}

function tool(
  tools: ReturnType<typeof buildVoiceCloneTools>,
  name: 'clip_audio' | 'register_voice',
): AgentTool<never, never> {
  return tools.find((candidate) => candidate.name === name)!;
}

describe('voice clone agent tools', () => {
  const sourceAudio = synthesizeStereoWav(4);

  beforeEach(() => {
    mocks.enabledServerTTSProviderIds.mockReset();
    mocks.enabledServerTTSProviderIds.mockReturnValue([]);
    mocks.resolveTTSApiKey.mockReset();
    mocks.resolveTTSApiKey.mockReturnValue('sk-test');
    mocks.resolveTTSBaseUrl.mockReset();
    mocks.resolveTTSBaseUrl.mockReturnValue('https://fake.example');
    mocks.getVoiceRegistrationAdapter.mockReset();
    mocks.getVoiceRegistrationAdapter.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { startSec: 0, endSec: 0.5 },
    { startSec: 0, endSec: 61 },
    { startSec: 5, endSec: 4 },
  ])('rejects an invalid clip duration: $startSec-$endSec', async ({ startSec, endSec }) => {
    const getMaterial = vi.fn();
    const clip = tool(buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial }), 'clip_audio');
    await expect(
      clip.execute('call_1', { materialId: 'mat_source', startSec, endSec } as never),
    ).rejects.toThrow('duration must be between 1 and 60 seconds');
    expect(getMaterial).not.toHaveBeenCalled();
  });

  it('rejects a material outside the current session', async () => {
    const getMaterial = vi.fn().mockResolvedValue(null);
    const clipAudio = vi.fn();
    const clip = tool(
      buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial, clipAudio }),
      'clip_audio',
    );
    await expect(
      clip.execute('call_1', { materialId: 'mat_foreign', startSec: 0, endSec: 2 } as never),
    ).rejects.toThrow('does not belong to this session owner');
    expect(getMaterial).toHaveBeenCalledWith('ses_1', 'mat_foreign');
    expect(clipAudio).not.toHaveBeenCalled();
  });

  it('rejects a material whose raw bytes are not in this session asset partition', async () => {
    // The row exists but its rawAssetId does not resolve under THIS session's
    // principal — the store-level cross-session isolation surfaces here as an
    // unavailable read, never as another session's bytes.
    const getMaterial = vi
      .fn()
      .mockResolvedValue(material({ kind: 'source', rawAssetId: 'ast_foreign' }));
    const readRawAsset = vi.fn().mockResolvedValue(null);
    const clip = tool(
      buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial, readRawAsset }),
      'clip_audio',
    );
    await expect(
      clip.execute('call_1', { materialId: 'mat_clip', startSec: 0, endSec: 2 } as never),
    ).rejects.toThrow('material bytes are unavailable');
  });

  it('rejects a material that is not audio or video', async () => {
    const getMaterial = vi
      .fn()
      .mockResolvedValue(material({ kind: 'web', rawAssetId: 'ast_text' }));
    const readRawAsset = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from('markdown body'), mime: 'text/markdown' });
    const clip = tool(
      buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial, readRawAsset }),
      'clip_audio',
    );
    await expect(
      clip.execute('call_1', { materialId: 'mat_web', startSec: 0, endSec: 2 } as never),
    ).rejects.toThrow('clip_audio requires an audio or video material');
  });

  it('does not register register_voice when no served provider supports registration', () => {
    const tools = buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial: vi.fn() });
    expect(tools.map((candidate) => candidate.name)).toEqual(['clip_audio']);
  });

  it('does not register register_voice when the adapter reports supportsRegistration false', () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    mocks.getVoiceRegistrationAdapter.mockReturnValue(
      fakeAdapter({ supportsRegistration: vi.fn(() => false) }),
    );
    const tools = buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial: vi.fn() });
    expect(tools.map((candidate) => candidate.name)).toEqual(['clip_audio']);
  });

  it('registers register_voice when an adapter supports registration for a served provider', () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    mocks.getVoiceRegistrationAdapter.mockReturnValue(fakeAdapter());
    const tools = buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial: vi.fn() });
    expect(tools.map((candidate) => candidate.name)).toEqual(['clip_audio', 'register_voice']);
  });

  it('registers the owner-scoped clip through the fake adapter and returns its real voice id', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    const adapter = fakeAdapter();
    mocks.getVoiceRegistrationAdapter.mockReturnValue(adapter);
    const wav = synthesizeVoiceCloneWav();
    const clip = material({ rawAssetId: 'ast_clip' });
    const getMaterial = vi.fn().mockResolvedValue(clip);
    const readRawAsset = vi.fn().mockResolvedValue({ bytes: wav, mime: 'audio/wav' });
    const register = tool(
      buildVoiceCloneTools({ sessionId: 'ses_1', getMaterial, readRawAsset }),
      'register_voice',
    );
    const result = await register.execute('call_1', {
      name: 'Andrew Ng',
      clipId: 'mat_clip',
      refText: 'Accurate words.',
    } as never);
    const duplicate = await register.execute('call_2', {
      name: 'Andrew Ng',
      clipId: 'mat_clip',
      refText: 'Accurate words.',
    } as never);

    expect(getMaterial).toHaveBeenCalledWith('ses_1', 'mat_clip');
    expect(adapter.registerVoice).toHaveBeenCalledOnce();
    const [cfg, params] = adapter.registerVoice.mock.calls[0];
    expect(cfg).toEqual({
      baseUrl: 'https://fake.example',
      apiKey: 'sk-test',
      model: 'fake-model',
    });
    expect(params).toMatchObject({
      voiceId: 'Andrew Ng',
      mimeType: 'audio/wav',
      refText: 'Accurate words.',
    });
    expect(params.referenceAudioBase64).toBe(wav.toString('base64'));
    expect(result.details).toEqual({
      providerId: 'fake-tts',
      voiceId: 'voice-Andrew Ng',
      name: 'Andrew Ng',
    });
    expect(duplicate.details).toEqual(result.details);
  });

  it('records the registered voice in the shared session registry (deduped)', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    const adapter = fakeAdapter();
    mocks.getVoiceRegistrationAdapter.mockReturnValue(adapter);
    const wav = synthesizeVoiceCloneWav();
    const registeredVoices: Array<{
      providerId: string;
      voiceId: string;
      name: string;
      kind?: string;
    }> = [];
    const register = tool(
      buildVoiceCloneTools({
        sessionId: 'ses_1',
        getMaterial: vi.fn().mockResolvedValue(material()),
        readRawAsset: vi.fn().mockResolvedValue({ bytes: wav, mime: 'audio/wav' }),
        registeredVoices: registeredVoices as never,
      }),
      'register_voice',
    );
    const params = { name: 'Dedup', clipId: 'mat_clip', refText: 'Accurate words.' } as never;
    await register.execute('call_1', params);
    await register.execute('call_2', params);
    expect(registeredVoices).toEqual([
      { providerId: 'fake-tts', voiceId: 'voice-Dedup', name: 'Dedup', kind: 'clone' },
    ]);
    expect(adapter.registerVoice).toHaveBeenCalledOnce();
  });

  it('rejects registration when the clip belongs to another session', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    mocks.getVoiceRegistrationAdapter.mockReturnValue(fakeAdapter());
    const register = tool(
      buildVoiceCloneTools({
        sessionId: 'ses_1',
        getMaterial: vi.fn().mockResolvedValue(null),
      }),
      'register_voice',
    );
    await expect(
      register.execute('call_1', {
        name: 'Andrew Ng',
        clipId: 'mat_foreign_clip',
        refText: 'Accurate words.',
      } as never),
    ).rejects.toThrow('does not belong to this session owner');
  });

  it('rejects registration when the clipId is not a voice-cloning reference clip', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    mocks.getVoiceRegistrationAdapter.mockReturnValue(fakeAdapter());
    const register = tool(
      buildVoiceCloneTools({
        sessionId: 'ses_1',
        getMaterial: vi.fn().mockResolvedValue(material({ kind: 'source' })),
      }),
      'register_voice',
    );
    await expect(
      register.execute('call_1', {
        name: 'Andrew Ng',
        clipId: 'mat_source',
        refText: 'Accurate words.',
      } as never),
    ).rejects.toThrow('clipId is not a voice-cloning reference clip');
  });

  it('rejects registration when the clip bytes are unavailable or corrupt', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    mocks.getVoiceRegistrationAdapter.mockReturnValue(fakeAdapter());
    const register = tool(
      buildVoiceCloneTools({
        sessionId: 'ses_1',
        getMaterial: vi.fn().mockResolvedValue(material()),
        readRawAsset: vi.fn().mockResolvedValue(null),
      }),
      'register_voice',
    );
    await expect(
      register.execute('call_1', {
        name: 'Andrew Ng',
        clipId: 'mat_clip',
        refText: 'Accurate words.',
      } as never),
    ).rejects.toThrow('voice-cloning reference clip is unavailable or corrupt');
  });

  it('rejects registration when the clip is not a 24 kHz mono WAV', async () => {
    mocks.enabledServerTTSProviderIds.mockReturnValue(['fake-tts']);
    mocks.getVoiceRegistrationAdapter.mockReturnValue(fakeAdapter());
    const register = tool(
      buildVoiceCloneTools({
        sessionId: 'ses_1',
        getMaterial: vi.fn().mockResolvedValue(material()),
        readRawAsset: vi
          .fn()
          .mockResolvedValue({ bytes: synthesizeStereoWav(2), mime: 'audio/wav' }),
      }),
      'register_voice',
    );
    await expect(
      register.execute('call_1', {
        name: 'Andrew Ng',
        clipId: 'mat_clip',
        refText: 'Accurate words.',
      } as never),
    ).rejects.toThrow('24 kHz mono PCM WAV');
  });

  it('clips to a 24 kHz mono PCM WAV and stores it as an audio-track material', async () => {
    const clipWav = synthesizeVoiceCloneWav(2);
    const getMaterial = vi
      .fn()
      .mockResolvedValue(
        material({ id: 'mat_source', kind: 'source', title: 'lecture.mp4', rawAssetId: 'ast_src' }),
      );
    const readRawAsset = vi.fn().mockResolvedValue({ bytes: sourceAudio, mime: 'video/mp4' });
    const storeRawAsset = vi.fn().mockResolvedValue('ast_clip_new');
    const createMaterial = vi.fn().mockResolvedValue(material({ rawAssetId: 'ast_clip_new' }));
    const clipAudio = vi.fn().mockResolvedValue(clipWav);
    const clip = tool(
      buildVoiceCloneTools({
        sessionId: 'ses_1',
        getMaterial,
        readRawAsset,
        storeRawAsset,
        createMaterial,
        clipAudio,
      }),
      'clip_audio',
    );
    const result = await clip.execute('call_1', {
      materialId: 'mat_source',
      startSec: 1,
      endSec: 3,
    } as never);

    expect(clipAudio).toHaveBeenCalledWith(sourceAudio, 'mat_source.mp4', 1, 3);
    expect(storeRawAsset).toHaveBeenCalledWith('ses_1', clipWav, 'audio/wav');
    expect(createMaterial).toHaveBeenCalledWith(
      'ses_1',
      expect.objectContaining({
        id: expect.stringMatching(/^mat_/),
        kind: 'audio-track',
        rawAssetId: 'ast_clip_new',
      }),
    );
    expect(result.details).toMatchObject({
      clipId: expect.stringMatching(/^mat_/),
      rawAssetId: 'ast_clip_new',
      durationSeconds: 2,
      mime: 'audio/wav',
    });
  });

  it('compensates the stored asset when the material row write fails', async () => {
    const getMaterial = vi
      .fn()
      .mockResolvedValue(material({ id: 'mat_source', kind: 'source', rawAssetId: 'ast_src' }));
    const readRawAsset = vi.fn().mockResolvedValue({ bytes: sourceAudio, mime: 'video/mp4' });
    const storeRawAsset = vi.fn().mockResolvedValue('ast_clip_new');
    const createMaterial = vi.fn().mockRejectedValue(new Error('row write failed'));
    const removeRawAsset = vi.fn().mockResolvedValue(undefined);
    const clip = tool(
      buildVoiceCloneTools({
        sessionId: 'ses_1',
        getMaterial,
        readRawAsset,
        storeRawAsset,
        createMaterial,
        removeRawAsset,
        clipAudio: vi.fn().mockResolvedValue(synthesizeVoiceCloneWav(2)),
      }),
      'clip_audio',
    );
    await expect(
      clip.execute('call_1', { materialId: 'mat_source', startSec: 0, endSec: 2 } as never),
    ).rejects.toThrow('row write failed');
    expect(removeRawAsset).toHaveBeenCalledWith('ses_1', 'ast_clip_new');
  });

  it.skipIf(!ffmpegAvailable)(
    'uses ffmpeg to store a 24 kHz mono PCM WAV from a stereo 48 kHz source',
    async () => {
      const getMaterial = vi.fn().mockResolvedValue(
        material({
          id: 'mat_source',
          kind: 'source',
          title: 'lecture.wav',
          rawAssetId: 'ast_src',
        }),
      );
      const readRawAsset = vi.fn().mockResolvedValue({ bytes: sourceAudio, mime: 'audio/wav' });
      const storeRawAsset = vi.fn().mockResolvedValue('ast_clip_new');
      const createMaterial = vi.fn().mockResolvedValue(material({ rawAssetId: 'ast_clip_new' }));
      const clip = tool(
        buildVoiceCloneTools({
          sessionId: 'ses_1',
          getMaterial,
          readRawAsset,
          storeRawAsset,
          createMaterial,
        }),
        'clip_audio',
      );
      const result = await clip.execute('call_1', {
        materialId: 'mat_source',
        startSec: 1,
        endSec: 3,
      } as never);

      expect(result.details).toMatchObject({
        durationSeconds: 2,
        mime: 'audio/wav',
      });
      const stored = (storeRawAsset as ReturnType<typeof vi.fn>).mock.calls[0][1] as Buffer;
      expect(stored.readUInt16LE(22)).toBe(1); // mono
      expect(stored.readUInt32LE(24)).toBe(24_000); // 24 kHz
    },
  );

  it('keeps VOICE_CLONE_TOOL_NAMES pinned to the two tool names', () => {
    expect(VOICE_CLONE_TOOL_NAMES).toEqual(['clip_audio', 'register_voice']);
  });
});
