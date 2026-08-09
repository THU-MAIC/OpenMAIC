import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function wavBytes(): ArrayBuffer {
  const data = new Uint8Array(16);
  data[0] = 0x52; // 'R'
  data[1] = 0x49; // 'I'
  data[2] = 0x46; // 'F'
  data[3] = 0x46; // 'F'
  data[8] = 0x57; // 'W'
  data[9] = 0x41; // 'A'
  data[10] = 0x56; // 'V'
  data[11] = 0x45; // 'E'
  return data.buffer;
}

describe('Lemonade TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts to /audio/speech with kokoro-v1 + wav and bubble-up audio bytes', async () => {
    const buffer = wavBytes();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => buffer,
      headers: { get: () => 'audio/wav' },
    });

    const result = await generateTTS(
      {
        providerId: 'lemonade-tts',
        baseUrl: 'http://localhost:13305/v1/',
        voice: 'af_heart',
      },
      'hello world',
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:13305/v1/audio/speech',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'kokoro-v1',
      input: 'hello world',
      voice: 'af_heart',
      speed: 1.0,
      response_format: 'wav',
    });
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.audio.byteLength).toBe(16);
    expect(result.format).toBe('wav');
  });

  it('falls back to af_heart when no voice is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => wavBytes(),
      headers: { get: () => 'audio/wav' },
    });

    await generateTTS({ providerId: 'lemonade-tts', voice: '' }, 'hi');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice).toBe('af_heart');
  });

  it('uses the selected voice consistently regardless of text language', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => wavBytes(),
      headers: { get: () => 'audio/wav' },
    });

    await generateTTS({ providerId: 'lemonade-tts', voice: 'af_heart' }, '给我讲讲 Python');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.voice).toBe('af_heart');
  });

  it('does not require an API key (keyless provider)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => wavBytes(),
      headers: { get: () => 'audio/wav' },
    });

    await generateTTS({ providerId: 'lemonade-tts', voice: 'af_heart' }, 'hi');

    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('attaches Bearer auth when apiKey is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => wavBytes(),
      headers: { get: () => 'audio/wav' },
    });

    await generateTTS({ providerId: 'lemonade-tts', apiKey: 'sk-lm', voice: 'af_heart' }, 'hi');

    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-lm');
  });

  it('throws on non-OK responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'bad voice',
      statusText: 'Bad Request',
    });

    await expect(generateTTS({ providerId: 'lemonade-tts', voice: 'foo' }, 'hi')).rejects.toThrow(
      /Lemonade TTS API error/,
    );
  });
});
