import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

function chatCompletionWithAudio(): object {
  return {
    id: 'test-id',
    choices: [
      {
        finish_reason: 'stop',
        index: 0,
        message: {
          content: '',
          role: 'assistant',
          audio: { id: 'audio-id', data: Buffer.from('RIFF-fake-wav').toString('base64') },
        },
      },
    ],
  };
}

describe('Xiaomi MiMo TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('posts to /chat/completions with assistant-role text and audio params', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => chatCompletionWithAudio(),
    });

    const result = await generateTTS(
      {
        providerId: 'xiaomi-tts',
        apiKey: 'tp-test',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1/',
        voice: '冰糖',
      },
      '你好，世界',
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tp-test');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: '你好，世界' }],
      audio: { format: 'wav', voice: '冰糖' },
    });
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.audio).toString()).toBe('RIFF-fake-wav');
    expect(result.format).toBe('wav');
  });

  it('defaults to mimo_default voice and mimo-v2.5-tts model', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => chatCompletionWithAudio(),
    });

    await generateTTS({ providerId: 'xiaomi-tts', apiKey: 'tp-test', voice: '' }, 'hi');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.audio.voice).toBe('mimo_default');
    expect(body.model).toBe('mimo-v2.5-tts');
  });

  it('translates non-default speed into a user-role style instruction', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => chatCompletionWithAudio(),
    });

    await generateTTS(
      { providerId: 'xiaomi-tts', apiKey: 'tp-test', voice: 'Mia', speed: 1.5 },
      'hello',
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('throws when the response carries no audio data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: '' } }] }),
    });

    await expect(
      generateTTS({ providerId: 'xiaomi-tts', apiKey: 'tp-test', voice: 'Mia' }, 'hi'),
    ).rejects.toThrow(/no audio data/);
  });

  it('throws on non-OK responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Param Incorrect' } }),
      statusText: 'Bad Request',
    });

    await expect(
      generateTTS({ providerId: 'xiaomi-tts', apiKey: 'tp-test', voice: 'Mia' }, 'hi'),
    ).rejects.toThrow(/Xiaomi MiMo TTS API error: Param Incorrect/);
  });
});
