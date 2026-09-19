import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ generateTTS: vi.fn() }));

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/tts-providers')>();
  return { ...actual, generateTTS: mocks.generateTTS };
});

import { POST } from '@/app/api/generate/tts/route';
import { QWEN_TTS_VOICE_CLONE_MODEL } from '@/lib/audio/constants';

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

describe('Qwen TTS route model-follows-voice invariant', () => {
  beforeEach(() => {
    mocks.generateTTS.mockReset().mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  });

  afterEach(() => vi.restoreAllMocks());

  it('never dispatches a catalog voice through VC even with a stale VC model', async () => {
    const response = await POST(request('Cherry', QWEN_TTS_VOICE_CLONE_MODEL));
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: 'Cherry',
        modelId: 'qwen3-tts-flash',
        speed: 1.25,
        providerOptions: expect.not.objectContaining({ qwenVoiceClone: true }),
      }),
      'Hello',
    );
  });

  it('routes a clone voice to VC and normalizes speed', async () => {
    const response = await POST(request('vendor-clone-id', 'qwen3-tts-flash'));
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({
        voice: 'vendor-clone-id',
        modelId: QWEN_TTS_VOICE_CLONE_MODEL,
        speed: 1,
        providerOptions: expect.objectContaining({ qwenVoiceClone: true }),
      }),
      'Hello',
    );
  });

  it('trims a catalog voice before clone detection and rejects whitespace-only voices', async () => {
    const response = await POST(request(' Cherry ', QWEN_TTS_VOICE_CLONE_MODEL));
    expect(response.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'Cherry', modelId: 'qwen3-tts-flash' }),
      'Hello',
    );

    const emptyResponse = await POST(request('   ', QWEN_TTS_VOICE_CLONE_MODEL));
    expect(emptyResponse.status).toBe(400);
  });
});
