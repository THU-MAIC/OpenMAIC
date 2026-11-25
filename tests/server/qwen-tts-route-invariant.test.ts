import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ generateTTS: vi.fn() }));

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/tts-providers')>();
  return { ...actual, generateTTS: mocks.generateTTS };
});

import { POST } from '@/app/api/generate/tts/route';
import { QWEN_VOICE_CLONE_GROUP_ID } from '@/lib/audio/constants';

function request(voice: string, modelId: string, speed = 1.25): NextRequest {
  return new NextRequest('http://localhost/api/generate/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Hello',
      audioId: 'audio-1',
      ttsProviderId: 'qwen-tts',
      ttsModelId: modelId,
      ttsVoice: voice,
      ttsSpeed: speed,
      ttsApiKey: 'caller-key',
    }),
  });
}

function qwenSlot(models: string[]) {
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        providers: { qwen: { preset: 'qwen-tts', apiKey: 'server-key', models } },
        slots: { tts: 'qwen:qwen3-tts-flash' },
      },
    },
    legacy: false,
    notices: [],
  });
}

describe('Qwen TTS route model-follows-voice invariant', () => {
  beforeEach(() => {
    setDeploymentConfigForTests({ layer: null, legacy: false, notices: [] });
    mocks.generateTTS.mockReset().mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setDeploymentConfigForTests();
  });

  it('accepts a persisted grouping ID with an authorized server-managed clone target', async () => {
    qwenSlot(['qwen3-tts-flash', 'cosyvoice-v3.5-plus']);
    const response = await POST(
      request('cosyvoice-v3.5-plus-teacher-id', QWEN_VOICE_CLONE_GROUP_ID),
    );
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'server-key',
        modelId: 'cosyvoice-v3.5-plus',
      }),
      'Hello',
    );
  });

  it.each(['qwen-tts-vc-retired-id', 'cosyvoice-v3-flash-other-id'])(
    'returns a recoverable incompatibility for %s under flash-only authorization',
    async (voice) => {
      qwenSlot(['qwen3-tts-flash']);
      const response = await POST(request(voice, QWEN_VOICE_CLONE_GROUP_ID));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        errorCode: 'QWEN_VC_RECLONE_REQUIRED',
        error: expect.stringContaining('re-clone'),
      });
      expect(mocks.generateTTS).not.toHaveBeenCalled();
    },
  );
  it('rejects an unauthorized clone target before generation', async () => {
    qwenSlot(['qwen3-tts-flash']);
    const response = await POST(request('cosyvoice-v3.5-plus-new-id', QWEN_VOICE_CLONE_GROUP_ID));
    expect(response.status).toBe(403);
    expect((await response.json()).errorCode).toBe('PROVIDER_DISABLED');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('self-heals a grouping ID with a catalog voice under flash-only slot authorization', async () => {
    qwenSlot(['qwen3-tts-flash']);
    const response = await POST(request('Cherry', QWEN_VOICE_CLONE_GROUP_ID));
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'server-key',
        voice: 'Cherry',
        modelId: 'qwen3-tts-flash',
      }),
      'Hello',
    );
  });

  it.each([QWEN_VOICE_CLONE_GROUP_ID, 'cosyvoice-v3.5-plus'])(
    'keeps a catalog voice on Qwen3 when the requested model is %s',
    async (modelId) => {
      const response = await POST(request('Cherry', modelId));
      expect(response.status).toBe(200);
      expect(mocks.generateTTS).toHaveBeenCalledWith(
        expect.objectContaining({
          voice: 'Cherry',
          modelId: 'qwen3-tts-flash',
          speed: 1.25,
        }),
        'Hello',
      );
    },
  );

  it('routes a clone voice to VC and normalizes speed', async () => {
    const response = await POST(request('cosyvoice-v3.5-plus-vendor-id', 'qwen3-tts-flash'));
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: 'cosyvoice-v3.5-plus-vendor-id',
        modelId: 'cosyvoice-v3.5-plus',
        speed: 1,
      }),
      'Hello',
    );
  });

  it('trims a catalog voice before clone detection and rejects whitespace-only voices', async () => {
    const response = await POST(request(' Cherry ', QWEN_VOICE_CLONE_GROUP_ID));
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'Cherry', modelId: 'qwen3-tts-flash' }),
      'Hello',
    );

    const emptyResponse = await POST(request('   ', QWEN_VOICE_CLONE_GROUP_ID));
    expect(emptyResponse.status).toBe(400);
  });
});

it('keeps configured Qwen catalogue voices on the authorised normal model', async () => {
  setDeploymentConfigForTests({
    layer: {
      source: 'deployment',
      config: {
        providers: {
          qwen: {
            preset: 'qwen-tts',
            apiKey: 'server-key',
            models: ['qwen3-tts'],
            voices: [{ id: 'vivian', name: 'Vivian' }],
          },
        },
        slots: { tts: 'qwen:qwen3-tts' },
      },
    },
    legacy: false,
    notices: [],
  });
  mocks.generateTTS.mockReset().mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  try {
    const response = await POST(request('vivian', 'qwen3-tts'));
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'qwen3-tts',
        voice: 'vivian',
        speed: 1.25,
        voices: [{ id: 'vivian', name: 'Vivian' }],
      }),
      'Hello',
    );
  } finally {
    setDeploymentConfigForTests();
  }
});
