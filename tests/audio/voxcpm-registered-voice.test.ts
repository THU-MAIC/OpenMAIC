import { describe, it, expect, vi } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';
import { VOXCPM_AUTO_VOICE_ID } from '@/lib/audio/voxcpm';
import type { TTSModelConfig } from '@/lib/audio/types';

// Provider requests go through undici's fetch with a pinned dispatcher.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

function stubSpeech() {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      }),
  );
  return fetchMock;
}

function lastPayload(f: ReturnType<typeof stubSpeech>) {
  const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe('VoxCPM vLLM-Omni registered voice', () => {
  it('references voice=registeredVoiceId and skips ref_audio / prompt prefix', async () => {
    const f = stubSpeech();
    const config: TTSModelConfig = {
      providerId: 'voxcpm-tts',
      voice: VOXCPM_AUTO_VOICE_ID,
      baseUrl: 'https://voxcpm.test/v1',
      providerOptions: { backend: 'vllm-omni', registeredVoiceId: 'voxcpm:voice:abc' },
    };

    await generateTTS(config, 'Hello class');

    const payload = lastPayload(f);
    expect(payload.voice).toBe('voxcpm:voice:abc');
    expect(payload.input).toBe('Hello class'); // no "(prompt)" prefix
    expect(payload.ref_audio).toBeUndefined();
  });

  it('keeps the inline prompt path (voice=default) when no registeredVoiceId', async () => {
    const f = stubSpeech();
    const config: TTSModelConfig = {
      providerId: 'voxcpm-tts',
      voice: VOXCPM_AUTO_VOICE_ID,
      baseUrl: 'https://voxcpm.test/v1',
      providerOptions: { backend: 'vllm-omni', voicePrompt: 'warm male teacher' },
    };

    await generateTTS(config, 'Hello class');

    const payload = lastPayload(f);
    expect(payload.voice).toBe('default');
    expect(payload.input).toBe('(warm male teacher)Hello class');
  });
});
