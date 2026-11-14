import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import { ASR_PROVIDERS } from '@/lib/audio/constants';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);
// The provider adapters issue requests through undici's fetch (with a pinned
// dispatcher), not the Next-patched global, so the double lives here.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

/** A 16 kHz mono 16-bit PCM WAV of `seconds` of silence. */
function pcmWav(seconds: number, { bits = 16, format = 1 } = {}): Buffer {
  const rate = 16000;
  const dataBytes = Math.round(seconds * rate) * (bits / 8);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(format, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * (bits / 8), 28);
  buf.writeUInt16LE(bits / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

function okResponse(text: string) {
  return new Response(JSON.stringify({ request_id: 'r', text, duration_ms: 1000 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('DeepSeek ASR', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('declares auto-detect only, WAV/Ogg input and chunks under the 120 s cap', () => {
    const provider = ASR_PROVIDERS['deepseek-asr'];
    expect(provider.supportedLanguages).toEqual(['auto']);
    expect(provider.supportedFormats).not.toContain('webm');
    expect(provider.maxChunkSeconds).toBeLessThan(120);
  });

  it('uploads the WAV as the multipart file field and returns the transcript', async () => {
    mockFetch.mockResolvedValueOnce(okResponse('今天天气怎么样'));

    const result = await transcribeAudio(
      { providerId: 'deepseek-asr', apiKey: 'sk-ds', language: 'zh' },
      pcmWav(1),
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/tools/asr');
    expect(init.headers.Authorization).toBe('Bearer sk-ds');
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['file']);
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.type).toBe('audio/wav');
    expect(result).toEqual({ text: '今天天气怎么样' });
  });

  it('uploads Ogg Opus as is', async () => {
    mockFetch.mockResolvedValueOnce(okResponse('hello'));
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]);

    await transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, ogg);

    const file = (mockFetch.mock.calls[0][1].body as FormData).get('file') as File;
    expect(file.name).toBe('audio.ogg');
  });

  it('refuses formats other than WAV and Ogg before any request', async () => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(
      transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, webm),
    ).rejects.toThrow('16-bit PCM WAV or Ogg Opus');
    await expect(
      transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, pcmWav(1, { bits: 8 })),
    ).rejects.toThrow('not 16-bit PCM');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses audio over 120 seconds with a clear message', async () => {
    await expect(
      transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, pcmWav(121)),
    ).rejects.toThrow('at most 120 seconds');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses Ogg Opus over 120 seconds from its granule position', async () => {
    // OpusHead (pre-skip 312) on the first page, then a last page whose
    // granule position counts 130 s of 48 kHz samples.
    const page = (granule: bigint, payload: Buffer) => {
      const header = Buffer.alloc(27);
      header.write('OggS', 0, 'ascii');
      header.writeBigInt64LE(granule, 6);
      return Buffer.concat([header, payload]);
    };
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head[8] = 1;
    head[9] = 1;
    head.writeUInt16LE(312, 10);
    const ogg = (seconds: number) =>
      Buffer.concat([page(BigInt(0), head), page(BigInt(seconds * 48000 + 312), Buffer.alloc(40))]);

    await expect(
      transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, ogg(130)),
    ).rejects.toThrow('at most 120 seconds');
    expect(mockFetch).not.toHaveBeenCalled();

    mockFetch.mockResolvedValueOnce(okResponse('short'));
    await transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, ogg(30));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses audio over 8 MiB', async () => {
    const big = Buffer.concat([pcmWav(1), Buffer.alloc(8 * 1024 * 1024)]);
    await expect(transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, big)).rejects.toThrow(
      'at most 8 MiB',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('carries the provider error message and status', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('{"error":{"message":"The service is busy"}}', { status: 503 }),
    );

    await expect(
      transcribeAudio({ providerId: 'deepseek-asr', apiKey: 'k' }, pcmWav(1)),
    ).rejects.toThrow('DeepSeek ASR API error (503): The service is busy');
  });
});

describe('mediaASRChunkSec', () => {
  it('keeps DeepSeek media chunks under its 120-second request cap', async () => {
    const { mediaASRChunkSec } = await import('@/lib/document/extractors/local-media');
    expect(mediaASRChunkSec('deepseek-asr')).toBeLessThan(120);
    expect(mediaASRChunkSec('deepseek-asr')).toBeGreaterThanOrEqual(60);
  });
});
