import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';
import { pcmS16leMonoToWav } from '@/lib/audio/pcm-wav';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

function fakePcm(bytes = 8): Uint8Array {
  const pcm = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) pcm[i] = i + 1;
  return pcm;
}

function readSampleRate(wav: Uint8Array): number {
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true);
}

describe('pcmS16leMonoToWav', () => {
  it('wraps PCM with a RIFF/WAVE header at 24 kHz', () => {
    const pcm = fakePcm(16);
    const wav = pcmS16leMonoToWav(pcm, 24_000);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(readSampleRate(wav)).toBe(24_000);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(Array.from(wav.slice(44))).toEqual(Array.from(pcm));
  });
});

describe('Google Gemini TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts to /interactions with speech_config and wraps PCM as wav', async () => {
    const pcm = fakePcm(12);
    const b64 = Buffer.from(pcm).toString('base64');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ output_audio: { data: b64 } }),
      headers: { get: () => null },
    });

    const result = await generateTTS(
      {
        providerId: 'google-tts',
        apiKey: 'test-key',
        voice: 'Kore',
        modelId: 'gemini-3.1-flash-tts-preview',
      },
      'hello classroom',
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = mockFetch.mock.calls[0][1];
    expect(init.headers['x-goog-api-key']).toBe('test-key');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'gemini-3.1-flash-tts-preview',
      input: 'hello classroom',
      response_format: { type: 'audio' },
      generation_config: {
        speech_config: [{ voice: 'Kore' }],
      },
    });

    expect(result.format).toBe('wav');
    expect(String.fromCharCode(...result.audio.slice(0, 4))).toBe('RIFF');
    expect(readSampleRate(result.audio)).toBe(24_000);
    expect(Array.from(result.audio.slice(44))).toEqual(Array.from(pcm));
  });

  it('defaults voice to Kore and model to gemini-3.1-flash-tts-preview', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        outputAudio: { data: Buffer.from(fakePcm()).toString('base64') },
      }),
      headers: { get: () => null },
    });

    await generateTTS({ providerId: 'google-tts', apiKey: 'k', voice: '' }, 'hi');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('gemini-3.1-flash-tts-preview');
    expect(body.generation_config.speech_config[0].voice).toBe('Kore');
  });

  it('respects a custom baseUrl without swallowing the path', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        output_audio: { data: Buffer.from(fakePcm()).toString('base64') },
      }),
      headers: { get: () => null },
    });

    await generateTTS(
      {
        providerId: 'google-tts',
        apiKey: 'k',
        voice: 'Puck',
        baseUrl: 'https://example.test/v1beta/',
      },
      'hi',
    );

    expect(mockFetch.mock.calls[0][0]).toBe('https://example.test/v1beta/interactions');
  });

  it('requires an API key', async () => {
    await expect(generateTTS({ providerId: 'google-tts', voice: 'Kore' }, 'hi')).rejects.toThrow(
      /API key required/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on non-OK responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'bad voice',
      statusText: 'Bad Request',
      headers: { get: () => null },
    });

    await expect(
      generateTTS({ providerId: 'google-tts', apiKey: 'k', voice: 'Kore' }, 'hi'),
    ).rejects.toThrow(/Google Gemini TTS API error/);
  });

  it('throws when the response has no audio data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'ok' }),
      headers: { get: () => null },
    });

    await expect(
      generateTTS({ providerId: 'google-tts', apiKey: 'k', voice: 'Kore' }, 'hi'),
    ).rejects.toThrow(/missing audio data/);
  });
});
