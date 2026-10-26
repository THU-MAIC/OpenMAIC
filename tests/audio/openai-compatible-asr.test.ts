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

  it('requests plain JSON for compatible model IDs instead of SDK verbose_json', async () => {
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
    const result = await transcribeAudio(
      { ...baseConfig, modelId: 'compatible-asr', language: 'zh' },
      audio,
    );
    expect(result).toEqual({ text: '你好，这是语音测试。' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://speech.example.com/v1/audio/transcriptions');
    expect(init.body.get('model')).toBe('compatible-asr');
    expect(init.body.get('language')).toBe('zh');
    expect(await init.body.get('file').arrayBuffer()).toEqual(
      audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    );
  });

  it('keeps the SDK path and verbose format for the original Whisper model', async () => {
    mockFetch.mockResolvedValueOnce(success());
    await transcribeAudio({ ...baseConfig, modelId: 'whisper-1', language: 'en' }, audio);
    expect(mockFetch.mock.calls[0][1].body.get('model')).toBe('whisper-1');
    expect(mockFetch.mock.calls[0][1].body.get('response_format')).toBe('verbose_json');
  });

  it('keeps the SDK JSON path for known OpenAI transcription models', async () => {
    mockFetch.mockResolvedValueOnce(success());
    await transcribeAudio({ ...baseConfig, modelId: 'gpt-4o-transcribe' }, audio);
    expect(mockFetch.mock.calls[0][1].body.get('response_format')).toBe('json');
  });

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
