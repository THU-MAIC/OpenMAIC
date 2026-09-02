import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

describe('MeRouter Seed TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('uses the OpenAI-compatible speech endpoint with the Seed model and server voice', async () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33]).buffer;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => bytes,
      headers: { get: () => 'audio/mpeg' },
    });

    const result = await generateTTS(
      {
        providerId: 'merouter-tts',
        apiKey: 'sk-test',
        baseUrl: 'https://gateway.example.test/v1',
        modelId: 'seed-tts-2.0',
        voice: 'zh_female_vv_uranus_bigtts',
      },
      '课堂语音测试。',
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gateway.example.test/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      model: 'seed-tts-2.0',
      input: '课堂语音测试。',
      voice: 'zh_female_vv_uranus_bigtts',
      speed: 1.0,
    });
    expect(result).toMatchObject({ format: 'mp3' });
    expect(result.audio).toEqual(new Uint8Array([0x49, 0x44, 0x33]));
  });
});
