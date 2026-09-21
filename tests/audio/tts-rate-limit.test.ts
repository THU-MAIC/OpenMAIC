import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateTTS, throwIfTtsRateLimited, TTSRateLimitError } from '@/lib/audio/tts-providers';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/audio-provider-fetch', () => ({
  audioProviderFetch: (url: string, init?: RequestInit) => fetchMock(url, init),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const miniMaxConfig = {
  providerId: 'minimax-tts' as const,
  apiKey: 'test-key',
  baseUrl: 'https://api.minimaxi.com',
  voice: 'female-yujie',
  modelId: 'speech-2.8-hd',
};

describe('throwIfTtsRateLimited', () => {
  it('throws a typed TTSRateLimitError on HTTP 429', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 429)).toThrow(TTSRateLimitError);
    try {
      throwIfTtsRateLimited('OpenAI', 429);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TTSRateLimitError);
      expect((e as TTSRateLimitError).provider).toBe('OpenAI');
    }
  });

  it('does not throw on non-429 statuses', () => {
    expect(() => throwIfTtsRateLimited('OpenAI', 200)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 401)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 500)).not.toThrow();
    expect(() => throwIfTtsRateLimited('OpenAI', 503)).not.toThrow();
  });
});

describe('MiniMax TTS rate-limit classification', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('throws TTSRateLimitError when MiniMax returns HTTP 200 with status_code 1002', async () => {
    // status_msg deliberately does not say "rate limit" or "1002": classification
    // is the numeric code, not the message text.
    fetchMock.mockResolvedValue(
      jsonResponse({
        base_resp: { status_code: 1002, status_msg: 'busy' },
      }),
    );

    try {
      await generateTTS(miniMaxConfig, 'hello');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TTSRateLimitError);
      expect((error as TTSRateLimitError).provider).toBe('MiniMax');
    }
  });

  it('keeps HTTP 429 on the MiniMax endpoint as TTSRateLimitError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'slow down' }, 429));

    await expect(generateTTS(miniMaxConfig, 'hello')).rejects.toBeInstanceOf(TTSRateLimitError);
  });

  it('does not treat other MiniMax status codes as rate limits', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
      }),
    );

    try {
      await generateTTS(miniMaxConfig, 'hello');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TTSRateLimitError);
    }
  });

  it('returns audio bytes when MiniMax status_code is 0', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: { audio: '00ff' },
        extra_info: { audio_format: 'mp3' },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    );

    await expect(generateTTS(miniMaxConfig, 'hello')).resolves.toEqual({
      audio: new Uint8Array([0x00, 0xff]),
      format: 'mp3',
    });
  });
});
