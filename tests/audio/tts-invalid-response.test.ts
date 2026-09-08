import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS, TTSInvalidResponseError } from '@/lib/audio/tts-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const mockRecordGenerationUsage = vi.fn();
vi.mock('@/lib/server/usage-storage', () => ({
  recordGenerationUsage: (...args: unknown[]) => mockRecordGenerationUsage(...args),
}));

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
    mockRecordGenerationUsage.mockClear();
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
      message: 'OpenAI TTS returned an HTML response instead of audio. Check provider base URL.',
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

  it('rejects 200 responses with JSON body with a generic message without leaking details', async () => {
    const jsonBody = JSON.stringify({
      error: 'Upstream quota exhausted / internal gateway secret',
      code: 'insufficient_quota',
      audioUrl: 'http://169.254.169.254/latest/meta-data/',
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
    ).rejects.toMatchObject({
      code: 'TTS_INVALID_RESPONSE',
      httpStatus: 502,
      message: 'OpenAI TTS returned a JSON response instead of audio.',
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

  it('rejects 200 responses with text/plain body with a generic message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      arrayBuffer: async () => stringToBuffer('Unauthorized: internal auth gateway failed'),
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
      message: 'OpenAI TTS returned text/plain instead of audio.',
    });
  });

  it('accepts audio responses starting with <, {, or [ when content-type starts with audio/ (e.g. PCM)', async () => {
    // Headerless audio formats like raw PCM, μ-law, and A-law have no magic numbers;
    // ~1.2% naturally start with '<' (0x3C), '{' (0x7B), or '[' (0x5B).
    const pcmBytes = new Uint8Array([0x3c, 0x00, 0x7b, 0x12, 0x5b, 0x34]);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/pcm' },
      arrayBuffer: async () => pcmBytes.buffer,
    });

    const result = await generateTTS(
      {
        providerId: 'openai-tts',
        apiKey: 'sk-test',
        voice: 'alloy',
      },
      'Hello',
    );

    expect(result.audio).toEqual(pcmBytes);
    expect(result.format).toBe('mp3');
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
  beforeEach(() => {
    mockFetch.mockReset();
    mockRecordGenerationUsage.mockClear();
  });

  it('surfaces 502 TTS_INVALID_RESPONSE and never records billing usage on invalid response', async () => {
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

    // Critical billing invariant: usage is never recorded when response is rejected as non-audio
    expect(mockRecordGenerationUsage).not.toHaveBeenCalled();
  });

  it('records billing usage only when audio generation succeeds (200)', async () => {
    const { NextRequest } = await import('next/server');
    const { POST } = await import('@/app/api/generate/tts/route');

    const audioData = wavBytes();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/wav' },
      arrayBuffer: async () => audioData,
    });

    const req = new NextRequest('http://localhost/api/generate/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Hello world',
        audioId: 'audio-test-456',
        ttsProviderId: 'openai-tts',
        ttsModelId: 'tts-1',
        ttsVoice: 'alloy',
        ttsApiKey: 'sk-test',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.audioId).toBe('audio-test-456');
    expect(json.base64).toBeDefined();

    // Billing usage recorded on success
    expect(mockRecordGenerationUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordGenerationUsage).toHaveBeenCalledWith({
      kind: 'tts',
      unit: 'character',
      providerId: 'openai-tts',
      modelId: 'tts-1',
      quantity: 11,
    });
  });
});
