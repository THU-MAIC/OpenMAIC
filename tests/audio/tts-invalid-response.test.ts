import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS, TTSInvalidResponseError } from '@/lib/audio/tts-providers';

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

function stringToBuffer(str: string): ArrayBuffer {
  const encoder = new TextEncoder();
  return encoder.encode(str).buffer;
}

describe('TTS Provider Response Validation (#1395)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects 200 responses with text/html body as non-audio', async () => {
    const html = '<!DOCTYPE html><html><body><h1>Welcome to My Website</h1></body></html>';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: async () => stringToBuffer(html),
    });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          baseUrl: 'https://example.com/api',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html; charset=utf-8' },
      arrayBuffer: async () => stringToBuffer(html),
    });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          baseUrl: 'https://example.com/api',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toMatchObject({
      code: 'TTS_INVALID_RESPONSE',
      httpStatus: 502,
    });
  });

  it('rejects 200 responses with HTML body even if content-type is missing or octet-stream', async () => {
    const html = '   \n\r\t<html><body>404 Not Found</body></html>';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/octet-stream' },
      arrayBuffer: async () => stringToBuffer(html),
    });

    await expect(
      generateTTS(
        {
          providerId: 'lemonade-tts',
          baseUrl: 'http://localhost:13305/v1',
          voice: 'af_heart',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);
  });

  it('rejects 200 responses with UTF-8 BOM followed by HTML', async () => {
    const bomHtml = '\uFEFF<!DOCTYPE html><html><body>Error</body></html>';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => stringToBuffer(bomHtml),
    });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);
  });

  it('rejects 200 responses with JSON body lacking an audioUrl', async () => {
    const jsonBody = JSON.stringify({
      error: 'Upstream quota exhausted',
      code: 'insufficient_quota',
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => stringToBuffer(jsonBody),
    });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      arrayBuffer: async () => stringToBuffer(jsonBody),
    });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toMatchObject({
      code: 'TTS_INVALID_RESPONSE',
      httpStatus: 502,
      message: expect.stringContaining('Upstream quota exhausted'),
    });
  });

  it('rejects 200 responses with empty body (0 bytes)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/mpeg' },
      arrayBuffer: async () => new ArrayBuffer(0),
    });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);
  });

  it('rejects 200 responses with text/plain body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      arrayBuffer: async () => stringToBuffer('Unauthorized: invalid token'),
    });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);
  });

  it('recognises JSON envelope with audioUrl, follows URL, and returns audio bytes', async () => {
    const audioBytes = wavBytes();
    const jsonEnvelope = JSON.stringify({
      audioUrl: 'https://cdn.example.com/audio/clip-123.wav',
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => stringToBuffer(jsonEnvelope),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => audioBytes,
      });

    const result = await generateTTS(
      {
        providerId: 'openai-tts',
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/v1',
        voice: 'alloy',
      },
      'Hello',
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe('https://cdn.example.com/audio/clip-123.wav');
    expect(result.audio).toEqual(new Uint8Array(audioBytes));
    expect(result.format).toBe('wav');
  });

  it('recognises JSON envelope with audio_url (snake_case) and relative path', async () => {
    const audioBytes = wavBytes();
    const jsonEnvelope = JSON.stringify({
      audio_url: '/v1/download/clip-456.wav',
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => stringToBuffer(jsonEnvelope),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'audio/wav' },
        arrayBuffer: async () => audioBytes,
      });

    const result = await generateTTS(
      {
        providerId: 'lemonade-tts',
        baseUrl: 'http://localhost:13305/v1',
        voice: 'af_heart',
      },
      'Hello',
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:13305/v1/download/clip-456.wav');
    expect(result.audio).toEqual(new Uint8Array(audioBytes));
    expect(result.format).toBe('wav');
  });

  it('rejects if audioUrl fetch itself fails with non-200 or non-audio', async () => {
    const jsonEnvelope = JSON.stringify({
      audioUrl: 'https://cdn.example.com/audio/dead-link.wav',
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => stringToBuffer(jsonEnvelope),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

    await expect(
      generateTTS(
        {
          providerId: 'openai-tts',
          apiKey: 'sk-test',
          voice: 'alloy',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);
  });

  it('protects custom OpenAI-compatible providers', async () => {
    const html = '<html><body>Custom proxy frontpage</body></html>';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => stringToBuffer(html),
    });

    await expect(
      generateTTS(
        {
          providerId: 'custom-tts-1',
          apiKey: 'sk-test',
          baseUrl: 'https://my-proxy.com',
          voice: 'custom-voice',
        },
        'Hello',
      ),
    ).rejects.toThrow(TTSInvalidResponseError);
  });
});

describe('POST /api/generate/tts route handling of invalid responses (#1395)', () => {
  it('surfaces 502 TTS_INVALID_RESPONSE and does not return base64 audio on HTML response', async () => {
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/generate/tts/route');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      arrayBuffer: async () => stringToBuffer('<!DOCTYPE html><html><body>Error</body></html>'),
    });

    const req = new NextRequest('http://localhost/api/generate/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello world',
        audioId: 'audio-test-123',
        ttsProviderId: 'openai-tts',
        ttsVoice: 'alloy',
        ttsApiKey: 'sk-test',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json).toMatchObject({
      success: false,
      errorCode: 'TTS_INVALID_RESPONSE',
      error: expect.stringContaining('HTML response instead of audio'),
    });
    expect(json.base64).toBeUndefined();
  });
});
