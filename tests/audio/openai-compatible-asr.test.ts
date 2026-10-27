import { beforeEach, describe, expect, it, vi } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';

const mockFetch = vi.hoisted(() => vi.fn());
vi.mock('@/lib/server/audio-provider-fetch', () => ({
  audioEndpointPolicy: () => ({}),
  audioProviderFetch: mockFetch,
  createAudioProviderFetch: () => mockFetch,
}));

const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
const baseConfig = {
  providerId: 'openai-whisper' as const,
  baseUrl: 'https://speech.example.com/v1',
  apiKey: 'test-key',
};

function success() {
  return new Response(JSON.stringify({ text: '你好，这是语音测试。' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenAI-compatible transcription response format', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each([
    'compatible-asr',
    'whisper-1',
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    undefined,
  ])('requests plain JSON for compatible endpoints using model %s', async (modelId) => {
    mockFetch.mockImplementation(async (_url, init) => {
      if (init.body.get('response_format') !== 'json') {
        return new Response(
          JSON.stringify({
            error: { message: 'Currently do not support verbose_json for /model' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return success();
    });
    const result = await transcribeAudio({ ...baseConfig, modelId, language: 'zh' }, audio);
    expect(result).toEqual({ text: '你好，这是语音测试。' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://speech.example.com/v1/audio/transcriptions');
    expect(init.body.get('model')).toBe(modelId || 'gpt-4o-mini-transcribe');
    expect(init.body.get('language')).toBe('zh');
    expect(await init.body.get('file').arrayBuffer()).toEqual(
      audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    );
  });

  describe.each([undefined, 'https://api.openai.com/v1', 'https://api.openai.com/v1/'])(
    'official OpenAI endpoint %s',
    (baseUrl) => {
      it.each([
        [undefined, 'gpt-4o-mini-transcribe', 'json'],
        ['whisper-1', 'whisper-1', 'verbose_json'],
        ['gpt-4o-transcribe', 'gpt-4o-transcribe', 'json'],
        ['gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe', 'json'],
      ])('preserves SDK behavior for model %s', async (modelId, expectedModel, format) => {
        mockFetch.mockResolvedValueOnce(success());
        await transcribeAudio({ ...baseConfig, baseUrl, modelId, language: 'en' }, audio);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions');
        expect(init.body.get('model')).toBe(expectedModel);
        expect(init.body.get('response_format')).toBe(format);
        expect(init.body.get('language')).toBe('en');
      });
    },
  );

  it('omits automatic language and tolerates provider-specific response fields', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: 'hello', duration: 2, segments: [{ text: 'hello' }] }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(
      await transcribeAudio({ ...baseConfig, modelId: 'compatible-asr', language: 'auto' }, audio),
    ).toEqual({ text: 'hello' });
    expect(mockFetch.mock.calls[0][1].body.has('language')).toBe(false);
  });
});
