import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS, TTSInvalidResponseError, TTSRateLimitError } from '@/lib/audio/tts-providers';
import { TTS_PROVIDERS } from '@/lib/audio/constants';
import { pcm16ToWav } from '@/lib/audio/google-tts';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const PCM = new Uint8Array([0x01, 0x00, 0xff, 0x7f]); // two 16-bit samples
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function interactionsResponse(part: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'x',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ignored' }, part] }],
    }),
  };
}

const ascii = (bytes: Uint8Array, from: number, len: number) =>
  String.fromCharCode(...bytes.slice(from, from + len));

describe('Google (Gemini) TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('is registered with 30 prebuilt voices, a key requirement and the 3.1 flash default', () => {
    const p = TTS_PROVIDERS['google-tts'];
    expect(p.requiresApiKey).toBe(true);
    expect(p.defaultModelId).toBe('gemini-3.1-flash-tts-preview');
    expect(p.voices).toHaveLength(30);
    expect(new Set(p.voices.map((v) => v.id)).size).toBe(30);
    expect(p.voices.map((v) => v.id)).toContain('Kore');
    expect(p.speedRange).toBeUndefined();
  });

  it('posts the documented Interactions body and wraps the PCM answer as WAV', async () => {
    mockFetch.mockResolvedValueOnce(
      interactionsResponse({
        type: 'audio',
        data: b64(PCM),
        mime_type: 'audio/L16;codec=pcm;rate=24000',
        sample_rate: 24000,
        channels: 1,
      }),
    );

    const result = await generateTTS(
      { providerId: 'google-tts', apiKey: 'k', voice: 'Kore' },
      'Merhaba dünya.',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(init.body)).toEqual({
      model: 'gemini-3.1-flash-tts-preview',
      input: 'Merhaba dünya.',
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    });

    expect(result.format).toBe('wav');
    expect(result.audio.byteLength).toBe(44 + PCM.byteLength);
    expect(ascii(result.audio, 0, 4)).toBe('RIFF');
    expect(ascii(result.audio, 8, 4)).toBe('WAVE');
    const view = new DataView(result.audio.buffer, result.audio.byteOffset);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(view.getUint32(40, true)).toBe(PCM.byteLength); // data chunk size
    expect(Array.from(result.audio.slice(44))).toEqual(Array.from(PCM));
  });

  it('passes a WAV answer through without wrapping it twice', async () => {
    const wav = pcm16ToWav(PCM, 24000, 1);
    mockFetch.mockResolvedValueOnce(
      interactionsResponse({ type: 'audio', data: b64(wav), mime_type: 'audio/wav' }),
    );

    const result = await generateTTS(
      {
        providerId: 'google-tts',
        apiKey: 'k',
        voice: 'Puck',
        modelId: 'gemini-2.5-flash-preview-tts',
      },
      'hi',
    );

    expect(JSON.parse(mockFetch.mock.calls[0][1].body).model).toBe('gemini-2.5-flash-preview-tts');
    expect(result.audio.byteLength).toBe(wav.byteLength);
  });

  it('accepts the SDK-style output_audio shape as a fallback', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 'x', output_audio: { data: b64(PCM) } }),
    });

    const result = await generateTTS({ providerId: 'google-tts', apiKey: 'k', voice: 'Kore' }, 'x');
    expect(result.audio.byteLength).toBe(44 + PCM.byteLength);
  });

  it('fails loud (TTSInvalidResponseError) when the interaction carries no audio part', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'x',
        status: 'completed',
        steps: [{ type: 'model_output', content: [] }],
      }),
    });

    await expect(
      generateTTS({ providerId: 'google-tts', apiKey: 'k', voice: 'Kore' }, 'x'),
    ).rejects.toBeInstanceOf(TTSInvalidResponseError);
  });

  it('maps 429 to TTSRateLimitError and surfaces the API error message otherwise', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' });
    await expect(
      generateTTS({ providerId: 'google-tts', apiKey: 'k', voice: 'Kore' }, 'x'),
    ).rejects.toBeInstanceOf(TTSRateLimitError);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { code: 400, message: 'voice not found' } }),
    });
    await expect(
      generateTTS({ providerId: 'google-tts', apiKey: 'k', voice: 'Nope' }, 'x'),
    ).rejects.toThrow(/Google TTS API error \(400\): voice not found/);
  });

  it('refuses to call the API without a key', async () => {
    await expect(generateTTS({ providerId: 'google-tts', voice: 'Kore' }, 'x')).rejects.toThrow(
      /API key required/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
