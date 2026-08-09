import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import { ASR_PROVIDERS } from '@/lib/audio/constants';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function wavBuffer(): Buffer {
  const buf = Buffer.alloc(16);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(8, 4);
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

function wavArrayBuffer(): ArrayBuffer {
  const buffer = wavBuffer();
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

describe('FunASR ASR', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('exposes the language hints documented by the FunASR CLI', () => {
    expect(ASR_PROVIDERS['funasr-asr'].supportedLanguages).toEqual([
      'auto',
      'zh',
      'en',
      'ja',
      'ko',
      'yue',
    ]);
  });

  it('posts WAV audio to /audio/transcriptions with an official FunASR model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello' }),
    });

    const result = await transcribeAudio(
      {
        providerId: 'funasr-asr',
        baseUrl: 'http://localhost:8000/v1/',
        modelId: 'fun-asr-nano',
      },
      wavBuffer(),
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST', headers: {} }),
    );
    const formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('model')).toBe('fun-asr-nano');
    expect(formData.get('response_format')).toBe('json');
    expect(formData.get('file')).toBeInstanceOf(Blob);
    expect(result).toEqual({ text: 'hello' });
  });

  it('uses SenseVoice as the local CPU-friendly default model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'ok' }),
    });

    await transcribeAudio({ providerId: 'funasr-asr' }, wavBuffer());
    const formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:8000/v1/audio/transcriptions');
    expect(formData.get('model')).toBe('sensevoice');
  });

  it('forwards an explicit language but not when set to "auto"', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: '' }),
    });

    await transcribeAudio({ providerId: 'funasr-asr', language: 'zh' }, wavBuffer());
    let formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('language')).toBe('zh');

    mockFetch.mockClear();

    await transcribeAudio({ providerId: 'funasr-asr', language: 'auto' }, wavBuffer());
    formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('language')).toBeNull();
  });

  it('adds bearer authentication only when an API key is configured', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: '' }),
    });

    await transcribeAudio({ providerId: 'funasr-asr', apiKey: ' local-secret ' }, wavBuffer());
    expect(mockFetch.mock.calls[0][1].headers).toEqual({
      Authorization: 'Bearer local-secret',
    });
  });

  it('rejects non-WAV audio buffers', async () => {
    const notWav = Buffer.from('IDXX' + '\0'.repeat(12));

    await expect(transcribeAudio({ providerId: 'funasr-asr' }, notWav)).rejects.toThrow(
      /WAV input only/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts WAV files even when the MIME type is missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello' }),
    });

    const audioFile = new File([wavArrayBuffer()], 'recording.wav');
    const result = await transcribeAudio({ providerId: 'funasr-asr' }, audioFile);

    expect(result).toEqual({ text: 'hello' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty text gracefully when upstream reports empty audio', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'audio is too short',
      statusText: 'Bad Request',
    });

    const result = await transcribeAudio({ providerId: 'funasr-asr' }, wavBuffer());
    expect(result).toEqual({ text: '' });
  });

  it('throws on unrecognized error payloads', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'model crashed',
      statusText: 'Internal Server Error',
    });

    await expect(transcribeAudio({ providerId: 'funasr-asr' }, wavBuffer())).rejects.toThrow(
      /FunASR ASR API error.*model crashed/,
    );
  });
});
