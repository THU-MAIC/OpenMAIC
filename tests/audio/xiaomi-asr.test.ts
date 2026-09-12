import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function wavBuffer(): Buffer {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

function chatCompletionWithText(text: string): object {
  return {
    id: 'test-id',
    choices: [{ finish_reason: 'stop', index: 0, message: { content: text, role: 'assistant' } }],
  };
}

describe('Xiaomi MiMo ASR', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts input_audio data URL to /chat/completions and returns the transcript', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => chatCompletionWithText('你好，世界'),
    });

    const result = await transcribeAudio(
      {
        providerId: 'xiaomi-asr',
        apiKey: 'tp-test',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1/',
        language: 'zh',
      },
      wavBuffer(),
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tp-test');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('mimo-v2.5-asr');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    const part = body.messages[0].content[0];
    expect(part.type).toBe('input_audio');
    expect(part.input_audio.data.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(body.asr_options).toEqual({ language: 'zh' });
    expect(result.text).toBe('你好，世界');
  });

  it('omits asr_options when language is auto', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => chatCompletionWithText('hello'),
    });

    await transcribeAudio(
      { providerId: 'xiaomi-asr', apiKey: 'tp-test', language: 'auto' },
      wavBuffer(),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.asr_options).toBeUndefined();
  });

  it('detects MP3 frame sync as audio/mpeg', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => chatCompletionWithText('ok'),
    });

    await transcribeAudio(
      { providerId: 'xiaomi-asr', apiKey: 'tp-test' },
      Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content[0].input_audio.data.startsWith('data:audio/mpeg;base64,')).toBe(
      true,
    );
  });

  it('rejects webm/opus recordings with a clear error instead of posting them', async () => {
    const webmHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(
      transcribeAudio(
        { providerId: 'xiaomi-asr', apiKey: 'tp-test' },
        new Blob([webmHeader], { type: 'audio/webm' }),
      ),
    ).rejects.toThrow(/wav\/mp3\/flac\/m4a\/ogg/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on non-OK responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Param Incorrect',
      statusText: 'Bad Request',
    });

    await expect(
      transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'tp-test' }, wavBuffer()),
    ).rejects.toThrow(/Xiaomi MiMo ASR API error: Param Incorrect/);
  });
});
