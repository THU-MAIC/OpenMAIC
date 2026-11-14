import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  deepseekTTSBilledChars,
  finalizeDeepSeekWav,
  generateTTS,
  TTSInvalidResponseError,
  TTSRateLimitError,
} from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);
// The provider adapters issue requests through undici's fetch (with a pinned
// dispatcher), not the Next-patched global, so the double lives here.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

/** A WAV as DeepSeek streams it: 24 kHz mono s16le, sizes left at 0xFFFFFFFF. */
function streamedWav(samples: number[]): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(0xffffffff, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(0xffffffff, 40);
  samples.forEach((sample, i) => buf.writeInt16LE(sample, 44 + i * 2));
  return buf;
}

function audioResponse(body: Uint8Array, contentType = 'audio/wav') {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

describe('DeepSeek TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('registers stella as the default voice with no model and no speed control', () => {
    const provider = TTS_PROVIDERS['deepseek-tts'];
    expect(provider.voices.map((voice) => voice.id)).toEqual(['stella', 'tide']);
    expect(DEFAULT_TTS_VOICES['deepseek-tts']).toBe('stella');
    expect(provider.models).toEqual([]);
    expect(provider.supportsSpeed).toBe(false);
    expect(`${provider.defaultBaseUrl}${provider.endpointPath}`).toBe(
      'https://api.deepseek.com/v1/tools/tts',
    );
  });

  it('posts the text, voice and wav format and returns a WAV with real sizes', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(streamedWav([1, -1, 2, -2])));

    const result = await generateTTS(
      { providerId: 'deepseek-tts', apiKey: 'sk-ds', voice: 'tide' },
      'Hello from DeepSeek.',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/tts');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-ds');
    expect(JSON.parse(init.body)).toEqual({
      text: 'Hello from DeepSeek.',
      voice_id: 'tide',
      format: 'wav',
    });

    expect(result.format).toBe('wav');
    const view = new DataView(result.audio.buffer, result.audio.byteOffset);
    expect(result.audio.byteLength).toBe(52);
    expect(view.getUint32(4, true)).toBe(44);
    expect(view.getUint32(40, true)).toBe(8);
  });

  it('defaults to stella and normalizes the official base URL to /v1', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(streamedWav([0, 0])));

    await generateTTS(
      { providerId: 'deepseek-tts', apiKey: 'k', voice: '', baseUrl: 'https://api.deepseek.com' },
      '你好',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/tts');
    expect(JSON.parse(init.body).voice_id).toBe('stella');
  });

  it('keeps a configured gateway path prefix', async () => {
    mockFetch.mockResolvedValueOnce(audioResponse(streamedWav([0, 0])));

    await generateTTS(
      { providerId: 'deepseek-tts', apiKey: 'k', voice: 'stella', baseUrl: 'https://gw.test/ds/' },
      'hi',
    );

    expect(mockFetch.mock.calls[0][0]).toBe('https://gw.test/ds/tools/tts');
  });

  it('counts a Chinese character as two billed characters and refuses texts over 10,000', async () => {
    expect(deepseekTTSBilledChars('ab 你好')).toBe(7);
    await expect(
      generateTTS({ providerId: 'deepseek-tts', apiKey: 'k', voice: 'stella' }, '字'.repeat(5001)),
    ).rejects.toThrow('at most 10000 billed characters');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps HTTP 429 to a rate-limit error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{"error":{"message":"too many"}}', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }),
    );

    const error = await generateTTS(
      { providerId: 'deepseek-tts', apiKey: 'k', voice: 'stella' },
      'hi',
    ).catch((e) => e);
    expect(error).toBeInstanceOf(TTSRateLimitError);
    expect(error.retryAfterMs).toBe(2000);
  });

  it('surfaces a content-review refusal with its message', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{"error":{"message":"Content Exists Risk"}}', { status: 400 }),
    );

    await expect(
      generateTTS({ providerId: 'deepseek-tts', apiKey: 'k', voice: 'stella' }, 'hi'),
    ).rejects.toThrow('DeepSeek TTS API error (400): Content Exists Risk');
  });

  it('refuses a 200 that carries JSON or a body that is not a PCM WAV', async () => {
    mockFetch.mockResolvedValueOnce(
      audioResponse(Buffer.from('{"error":{"message":"x"}}'), 'application/json'),
    );
    await expect(
      generateTTS({ providerId: 'deepseek-tts', apiKey: 'k', voice: 'stella' }, 'hi'),
    ).rejects.toBeInstanceOf(TTSInvalidResponseError);

    mockFetch.mockResolvedValueOnce(audioResponse(Buffer.from('ID3 not a wav at all, no')));
    await expect(
      generateTTS({ providerId: 'deepseek-tts', apiKey: 'k', voice: 'stella' }, 'hi'),
    ).rejects.toBeInstanceOf(TTSInvalidResponseError);
  });

  it('drops a trailing partial sample and refuses a header with no samples', () => {
    const cut = Buffer.concat([streamedWav([5, 6]), Buffer.from([7])]);
    const fixed = finalizeDeepSeekWav(new Uint8Array(cut));
    expect(fixed.byteLength).toBe(48);
    expect(new DataView(fixed.buffer).getUint32(40, true)).toBe(4);

    expect(() => finalizeDeepSeekWav(new Uint8Array(streamedWav([])))).toThrow(
      TTSInvalidResponseError,
    );
  });
});
