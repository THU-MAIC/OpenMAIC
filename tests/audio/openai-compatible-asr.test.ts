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

  describe.each(['openai-whisper', 'custom-asr-local'] as const)(
    'multipart audio metadata for %s',
    (providerId) => {
      it.each([false, true])(
        'uploads WAV buffers with matching MIME and filename (sliced: %s)',
        async (sliced) => {
          const wav = Buffer.alloc(46);
          wav.write('RIFF', 0, 'ascii');
          wav.writeUInt32LE(38, 4);
          wav.write('WAVE', 8, 'ascii');
          const input = sliced
            ? Buffer.concat([Buffer.from('prefix'), wav, Buffer.from('suffix')]).subarray(6, 52)
            : wav;
          mockFetch.mockImplementation(async (_url, init) => {
            const file = init.body.get('file') as File;
            if (file.type !== 'audio/wav') {
              return new Response('WAV content type required', { status: 415 });
            }
            return success();
          });

          const result = await transcribeAudio(
            { ...baseConfig, providerId, modelId: 'whisper-1' },
            input,
          );

          expect(result).toEqual({ text: '你好，这是语音测试。' });
          expect(mockFetch).toHaveBeenCalledTimes(1);
          const file = mockFetch.mock.calls[0][1].body.get('file') as File;
          expect(file.type).toBe('audio/wav');
          expect(file.name).toBe('audio.wav');
          expect(Buffer.from(await file.arrayBuffer())).toEqual(wav);
        },
      );

      it('keeps WebM buffer uploads labeled as WebM', async () => {
        mockFetch.mockResolvedValueOnce(success());
        await transcribeAudio({ ...baseConfig, providerId, modelId: 'whisper-1' }, audio);
        const file = mockFetch.mock.calls[0][1].body.get('file') as File;
        expect(file.type).toBe('audio/webm');
        expect(file.name).toBe('audio.webm');
        expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
      });

      it.each(['audio/wav', 'audio/x-wav'])('preserves an existing %s Blob', async (type) => {
        const input = new Blob([new Uint8Array([1, 2, 3])], { type });
        mockFetch.mockResolvedValueOnce(success());
        await transcribeAudio({ ...baseConfig, providerId, modelId: 'whisper-1' }, input);
        const file = mockFetch.mock.calls[0][1].body.get('file') as File;
        expect(file.type).toBe(type);
        expect(file.name).toBe('audio.wav');
        expect(await file.arrayBuffer()).toEqual(await input.arrayBuffer());
      });
    },
  );

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
