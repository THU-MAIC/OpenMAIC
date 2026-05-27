import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';

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

describe('Lemonade ASR', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts WAV audio to /audio/transcriptions with the configured model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'hello' }),
    });

    const result = await transcribeAudio(
      {
        providerId: 'lemonade-asr',
        baseUrl: 'http://localhost:13305/v1/',
        modelId: 'Whisper-Base',
      },
      wavBuffer(),
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:13305/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' }),
    );
    const formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('model')).toBe('Whisper-Base');
    expect(formData.get('response_format')).toBe('json');
    expect(formData.get('file')).toBeInstanceOf(Blob);
    expect(result).toEqual({ text: 'hello' });
  });

  it('forwards an explicit language but not when set to "auto"', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: '' }),
    });

    await transcribeAudio({ providerId: 'lemonade-asr', language: 'en' }, wavBuffer());
    let formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('language')).toBe('en');

    mockFetch.mockClear();

    await transcribeAudio({ providerId: 'lemonade-asr', language: 'auto' }, wavBuffer());
    formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('language')).toBeNull();
  });

  it('rejects non-WAV audio buffers', async () => {
    const notWav = Buffer.from('IDXX' + '\0'.repeat(12));

    await expect(transcribeAudio({ providerId: 'lemonade-asr' }, notWav)).rejects.toThrow(
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
    const result = await transcribeAudio({ providerId: 'lemonade-asr' }, audioFile);

    expect(result).toEqual({ text: 'hello' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns empty text gracefully when upstream reports empty audio', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'audio is empty',
      statusText: 'Bad Request',
    });

    const result = await transcribeAudio({ providerId: 'lemonade-asr' }, wavBuffer());
    expect(result).toEqual({ text: '' });
  });

  it('throws on unrecognized error payloads', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'model crashed',
      statusText: 'Internal Server Error',
    });

    await expect(transcribeAudio({ providerId: 'lemonade-asr' }, wavBuffer())).rejects.toThrow(
      /Lemonade ASR API error.*model crashed/,
    );
  });

  it('falls back to default model id when not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'ok' }),
    });

    await transcribeAudio({ providerId: 'lemonade-asr' }, wavBuffer());
    const formData = mockFetch.mock.calls[0][1].body as FormData;
    expect(formData.get('model')).toBe('Whisper-Base');
  });
});
