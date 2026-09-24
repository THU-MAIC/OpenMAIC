import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

function mp3Response() {
  return {
    ok: true,
    arrayBuffer: async () => new Uint8Array([0x49, 0x44, 0x33, 0x04]).buffer,
    headers: { get: () => 'audio/mpeg' },
  };
}

describe('Speechify TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts to /audio/stream with Bearer auth and returns mp3 bytes', async () => {
    mockFetch.mockResolvedValueOnce(mp3Response());

    const result = await generateTTS(
      { providerId: 'speechify-tts', apiKey: 'sk-test', voice: 'geffen_32' },
      'hello world',
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.speechify.ai/v1/audio/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.headers.Accept).toBe('audio/mpeg');
    expect(JSON.parse(init.body)).toEqual({
      input: 'hello world',
      voice_id: 'geffen_32',
      model: 'simba-3.2',
    });
    expect(result.format).toBe('mp3');
    expect(result.audio.byteLength).toBe(4);
  });

  it('maps speed to an SSML prosody rate and escapes the text', async () => {
    mockFetch.mockResolvedValueOnce(mp3Response());

    await generateTTS(
      { providerId: 'speechify-tts', apiKey: 'sk-test', voice: 'george', speed: 1.5 },
      'a < b & c',
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.input).toBe('<speak><prosody rate="+50%">a &lt; b &amp; c</prosody></speak>');
  });

  it('throws on non-OK responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'voice not found',
      statusText: 'Bad Request',
      headers: { get: () => null },
    });

    await expect(
      generateTTS({ providerId: 'speechify-tts', apiKey: 'sk-test', voice: 'nope' }, 'hi'),
    ).rejects.toThrow(/Speechify TTS API error/);
  });
});
