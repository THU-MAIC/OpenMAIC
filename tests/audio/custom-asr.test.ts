import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function webmBuffer(): Buffer {
  // Minimal non-WAV buffer (no RIFF/WAVE magic bytes)
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);
}

describe('Custom ASR provider (custom-asr-*)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts audio to /audio/transcriptions and returns text', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '嗯嗯' }),
    });

    const result = await transcribeAudio(
      {
        providerId: 'custom-asr-siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        apiKey: 'sk-test',
      },
      webmBuffer(),
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.siliconflow.cn/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual({ text: '嗯嗯' });
  });

  it('tolerates extra fields in the response (segments, duration, usage)', async () => {
    // This is the exact SiliconFlow response shape that broke the AI SDK parser
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        duration: 1.5,
        text: '嗯嗯',
        segments: [{ id: 0, start: 0.0, end: 1.5, text: '嗯嗯' }],
        usage: { tokens: 10 },
      }),
    });

    const result = await transcribeAudio(
      {
        providerId: 'custom-asr-siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        apiKey: 'sk-test',
      },
      webmBuffer(),
    );

    expect(result).toEqual({ text: '嗯嗯' });
  });

  it('strips trailing slash from base URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'ok' }),
    });

    await transcribeAudio(
      {
        providerId: 'custom-asr-myhost',
        baseUrl: 'http://localhost:9000/v1/',
        modelId: 'whisper-1',
        apiKey: 'key',
      },
      webmBuffer(),
    );

    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:9000/v1/audio/transcriptions');
  });

  it('sends Bearer auth header when an API key is configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    });

    await transcribeAudio(
      {
        providerId: 'custom-asr-siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        apiKey: ' sk-secret ',
      },
      webmBuffer(),
    );

    expect(mockFetch.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer sk-secret',
    });
  });

  it('throws when no model ID is configured', async () => {
    await expect(
      transcribeAudio(
        {
          providerId: 'custom-asr-siliconflow',
          baseUrl: 'https://api.siliconflow.cn/v1',
          apiKey: 'sk-test',
          // modelId intentionally omitted
        },
        webmBuffer(),
      ),
    ).rejects.toThrow(/requires a model ID/);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('omits auth header when no API key is set', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    });

    await transcribeAudio(
      {
        providerId: 'custom-asr-local',
        baseUrl: 'http://localhost:9000/v1',
        modelId: 'whisper-1',
      },
      webmBuffer(),
    );

    expect(mockFetch.mock.calls[0][1].headers).toEqual({});
  });

  it('sets model, response_format, and language in FormData', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    });

    await transcribeAudio(
      {
        providerId: 'custom-asr-siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        apiKey: 'sk-test',
        language: 'zh',
      },
      webmBuffer(),
    );

    const formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('model')).toBe('FunAudioLLM/SenseVoiceSmall');
    expect(formData.get('response_format')).toBe('json');
    expect(formData.get('language')).toBe('zh');
    expect(formData.get('file')).toBeInstanceOf(Blob);
  });

  it('omits language field when set to "auto"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '' }),
    });

    await transcribeAudio(
      {
        providerId: 'custom-asr-siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        language: 'auto',
      },
      webmBuffer(),
    );

    const formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('language')).toBeNull();
  });

  it('returns empty text when upstream reports audio is empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'audio is empty',
      statusText: 'Bad Request',
    });

    const result = await transcribeAudio(
      {
        providerId: 'custom-asr-siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        apiKey: 'sk-test',
      },
      webmBuffer(),
    );

    expect(result).toEqual({ text: '' });
  });

  it('throws a descriptive error on non-empty upstream failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
      statusText: 'Unauthorized',
    });

    await expect(
      transcribeAudio(
        {
          providerId: 'custom-asr-siliconflow',
          baseUrl: 'https://api.siliconflow.cn/v1',
          modelId: 'FunAudioLLM/SenseVoiceSmall',
          apiKey: 'sk-bad',
        },
        webmBuffer(),
      ),
    ).rejects.toThrow(/Custom ASR API error.*401/);
  });

  it('throws when no base URL is configured', async () => {
    await expect(
      transcribeAudio(
        {
          providerId: 'custom-asr-siliconflow',
          baseUrl: '',
          modelId: 'FunAudioLLM/SenseVoiceSmall',
          apiKey: 'sk-test',
        },
        webmBuffer(),
      ),
    ).rejects.toThrow(/requires a base URL/);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts a Blob input directly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello' }),
    });

    const audioBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const result = await transcribeAudio(
      {
        providerId: 'custom-asr-siliconflow',
        baseUrl: 'https://api.siliconflow.cn/v1',
        modelId: 'FunAudioLLM/SenseVoiceSmall',
        apiKey: 'sk-test',
      },
      audioBlob,
    );

    expect(result).toEqual({ text: 'hello' });
    const formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('file')).toBeInstanceOf(Blob);
  });
});
