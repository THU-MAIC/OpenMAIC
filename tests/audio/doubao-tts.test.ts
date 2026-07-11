import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

// Build the chunked NDJSON body the Doubao /unidirectional endpoint streams:
// one {code,data} JSON object per line, ending with the 20000000 sentinel.
function ndjsonBody(audioChunksB64: string[]): string {
  const lines = audioChunksB64.map((d) => JSON.stringify({ code: 0, data: d }));
  lines.push(JSON.stringify({ code: 20000000, message: 'done' }));
  return lines.join('\n');
}

function okResponse(body: string) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    headers: { get: () => 'application/json' },
  };
}

const helloB64 = Buffer.from([1, 2, 3, 4]).toString('base64');

describe('Doubao TTS dual auth', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('uses X-Api-Key + plan endpoint for an Agent Plan single key (no colon)', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(ndjsonBody([helloB64])));

    const result = await generateTTS(
      {
        providerId: 'doubao-tts',
        apiKey: 'ark-plan-key-123',
        baseUrl: 'https://openspeech.bytedance.com/api/plan/tts',
        voice: 'zh_female_vv_uranus_bigtts',
      },
      '你好',
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://openspeech.bytedance.com/api/plan/tts/unidirectional');
    expect(init.headers['X-Api-Key']).toBe('ark-plan-key-123');
    expect(init.headers['X-Api-Resource-Id']).toBe('seed-tts-2.0');
    // Plan mode must NOT send the appId/accessKey pair headers.
    expect(init.headers['X-Api-App-Id']).toBeUndefined();
    expect(init.headers['X-Api-Access-Key']).toBeUndefined();
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.audio.byteLength).toBe(4);
  });

  it('uses X-Api-App-Id + X-Api-Access-Key for a classic appId:accessKey key', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(ndjsonBody([helloB64])));

    await generateTTS(
      {
        providerId: 'doubao-tts',
        apiKey: 'app123:secretAccessKey',
        voice: 'zh_female_vv_uranus_bigtts',
      },
      '你好',
    );

    const init = mockFetch.mock.calls[0][1];
    expect(init.headers['X-Api-App-Id']).toBe('app123');
    expect(init.headers['X-Api-Access-Key']).toBe('secretAccessKey');
    expect(init.headers['X-Api-Key']).toBeUndefined();
  });

  it('rejects an empty key before making a request', async () => {
    // The generic generateTTS guard (requiresApiKey && !apiKey) fires first.
    await expect(
      generateTTS({ providerId: 'doubao-tts', apiKey: '', voice: 'x' }, 'hi'),
    ).rejects.toThrow(/API key required for TTS provider: doubao-tts/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed appId:accessKey (empty half) without a request', async () => {
    await expect(
      generateTTS({ providerId: 'doubao-tts', apiKey: 'appId:', voice: 'x' }, 'hi'),
    ).rejects.toThrow(/appId:accessKey is malformed/);
    await expect(
      generateTTS({ providerId: 'doubao-tts', apiKey: ':secret', voice: 'x' }, 'hi'),
    ).rejects.toThrow(/appId:accessKey is malformed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('aggregates base64 audio chunks across the NDJSON stream', async () => {
    const a = Buffer.from([1, 2]).toString('base64');
    const b = Buffer.from([3, 4, 5]).toString('base64');
    mockFetch.mockResolvedValueOnce(okResponse(ndjsonBody([a, b])));

    const result = await generateTTS(
      { providerId: 'doubao-tts', apiKey: 'ark-k', voice: 'v' },
      'hi',
    );

    expect(Array.from(result.audio)).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses concatenated JSON errors whose message contains braces', async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse(
        JSON.stringify({ code: 0, data: helloB64 }) +
          JSON.stringify({ code: 40000001, message: 'bad payload: {"field":"text"}' }),
      ),
    );

    await expect(
      generateTTS({ providerId: 'doubao-tts', apiKey: 'ark-k', voice: 'v' }, 'hi'),
    ).rejects.toThrow(/bad payload: \{"field":"text"\}/);
  });
});
