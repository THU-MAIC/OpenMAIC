import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);
// The provider adapters issue requests through undici's fetch (with a pinned
// dispatcher), not the Next-patched global, so the double lives here.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

// A minimal valid WAV: 44-byte RIFF/WAVE header + 4 payload bytes.
function minimalWav(): Buffer {
  const buf = Buffer.alloc(48);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(40, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('data', 12, 'ascii');
  buf.writeUInt32LE(4, 16);
  buf.set([1, 2, 3, 4], 20);
  return buf;
}
const wavB64 = minimalWav().toString('base64');

function chatResponse(audioB64: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { audio: { data: audioB64 } } }],
    }),
  };
}

describe('Xiaomi MiMo TTS', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('synthesizes through chat/completions with the text in an assistant message', async () => {
    mockFetch.mockResolvedValueOnce(chatResponse(wavB64));

    const result = await generateTTS(
      {
        providerId: 'xiaomi-tts',
        apiKey: 'mimo-key',
        voice: '冰糖',
      },
      '你好，世界',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer mimo-key');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('mimo-v2.5-tts');
    expect(body.audio).toEqual({ format: 'wav', voice: '冰糖' });
    // The provider rule: the text to synthesize rides in an assistant message.
    expect(body.messages).toEqual([{ role: 'assistant', content: '你好，世界' }]);
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.audio.byteLength).toBe(48);
    expect(result.format).toBe('wav');
  });

  it('translates a non-default speed into a user style instruction', async () => {
    mockFetch.mockResolvedValueOnce(chatResponse(wavB64));

    await generateTTS({ providerId: 'xiaomi-tts', apiKey: 'k', voice: 'Mia', speed: 1.5 }, 'hello');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'user', content: '说得快一些，语速偏快。' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('keeps the assistant message last for a slowed request', async () => {
    mockFetch.mockResolvedValueOnce(chatResponse(wavB64));

    await generateTTS(
      { providerId: 'xiaomi-tts', apiKey: 'k', voice: 'Mia', speed: 0.5 },
      '慢一点',
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(body.messages[0].content).toBe('说得慢一些，语速偏慢。');
  });

  it('throws a descriptive error when the response carries no audio', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
    });

    await expect(
      generateTTS({ providerId: 'xiaomi-tts', apiKey: 'k', voice: 'Mia' }, 'hello'),
    ).rejects.toThrow('Xiaomi MiMo TTS API returned no audio data');
  });

  it('surfaces the provider error message on an HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => null },
      json: async () => ({ error: { message: 'invalid api key' } }),
    });

    await expect(
      generateTTS({ providerId: 'xiaomi-tts', apiKey: 'bad', voice: 'Mia' }, 'hello'),
    ).rejects.toThrow('invalid api key');
  });
});
