import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);
// The provider adapters issue requests through undici's fetch (with a pinned
// dispatcher), not the Next-patched global, so the double lives here.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

function wavBuffer(): Buffer {
  const buf = Buffer.alloc(16);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(8, 4);
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

describe('Xiaomi MiMo ASR', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('transcribes through chat/completions with the sample as an input_audio part', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '识别结果' } }] }),
    });

    const result = await transcribeAudio(
      { providerId: 'xiaomi-asr', apiKey: 'mimo-key' },
      wavBuffer(),
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer mimo-key');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('mimo-v2.5-asr');
    const part = body.messages[0].content[0];
    expect(part.type).toBe('input_audio');
    expect(part.input_audio.data).toMatch(/^data:audio\/wav;base64,/);
    // A wav sample sniffed from the bytes, and no language hint when unset.
    expect(body.asr_options).toBeUndefined();
    expect(result.text).toBe('识别结果');
  });

  it('passes asr_options when a language hint is configured', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    });

    await transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k', language: 'en' }, wavBuffer());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.asr_options).toEqual({ language: 'en' });
  });

  it('refuses a sample it cannot identify as a supported format', async () => {
    const junk = Buffer.alloc(16, 0x7f);

    await expect(transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k' }, junk)).rejects.toThrow(
      'supports wav/mp3 audio only',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses an encoded payload over the 10 MB provider limit', async () => {
    const big = Buffer.concat([wavBuffer(), Buffer.alloc(11 * 1024 * 1024)]);

    await expect(transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k' }, big)).rejects.toThrow(
      'exceeds the documented 10 MB input_audio limit',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a WebM upload that claims to be WAV by content type', async () => {
    // Bytes are EBML (WebM), the declared type says wav: the bytes win.
    const webm = Buffer.alloc(16);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    const blob = new Blob([webm], { type: 'audio/wav' });

    await expect(transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k' }, blob)).rejects.toThrow(
      'supports wav/mp3 audio only',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects flac and ogg samples locally as unsupported formats', async () => {
    // "fLaC" magic — a well-formed file the provider does not document.
    const flac = Buffer.alloc(16);
    flac.set([0x66, 0x4c, 0x61, 0x43], 0);
    // "OggS" magic.
    const ogg = Buffer.alloc(16);
    ogg.set([0x4f, 0x67, 0x67, 0x53], 0);

    await expect(transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k' }, flac)).rejects.toThrow(
      'supports wav/mp3 audio only',
    );
    await expect(transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k' }, ogg)).rejects.toThrow(
      'supports wav/mp3 audio only',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects ADTS AAC despite the shared MPEG sync word', async () => {
    // ADTS AAC starts FF F1 (MPEG-4) / FF F9 (MPEG-2): the sync word matches
    // an MP3 frame, but the layer bits are always 00 where MP3 is nonzero.
    const aacMpeg4 = Buffer.alloc(16);
    aacMpeg4.set([0xff, 0xf1], 0);
    const aacMpeg2 = Buffer.alloc(16);
    aacMpeg2.set([0xff, 0xf9], 0);

    await expect(
      transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k' }, aacMpeg4),
    ).rejects.toThrow('supports wav/mp3 audio only');
    await expect(
      transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'k' }, aacMpeg2),
    ).rejects.toThrow('supports wav/mp3 audio only');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces the provider error text on an HTTP failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    });

    await expect(
      transcribeAudio({ providerId: 'xiaomi-asr', apiKey: 'bad' }, wavBuffer()),
    ).rejects.toThrow('invalid api key');
  });
});

describe('mediaASRChunkSec', () => {
  it('shortens chunks for Xiaomi MiMo so WAV+base64 stays under its 10 MB cap', async () => {
    const { mediaASRChunkSec } = await import('@/lib/document/extractors/local-media');
    expect(mediaASRChunkSec('xiaomi-asr')).toBeLessThan(246); // ~10 MB base64 ceiling at 16 kHz mono
    expect(mediaASRChunkSec('xiaomi-asr')).toBeGreaterThanOrEqual(120); // not uselessly short
    expect(mediaASRChunkSec('doubao-asr')).toBe(600);
    expect(mediaASRChunkSec()).toBe(600);
    const { mediaChunkWindows } = await import('@/lib/document/extractors/local-media');
    // A 10-minute recording becomes 4 MiMo-sized chunks instead of 1.
    expect(mediaChunkWindows(600, mediaASRChunkSec('xiaomi-asr')).length).toBe(4);
  });
});

describe('Xiaomi MiMo ASR provider metadata', () => {
  it('advertises the request path the adapter actually posts to', async () => {
    // The settings request-URL hint renders defaultBaseUrl + endpointPath;
    // it must match what transcribeXiaomiASR really calls.
    const { ASR_PROVIDERS } = await import('@/lib/audio/constants');
    expect(ASR_PROVIDERS['xiaomi-asr'].endpointPath).toBe('/chat/completions');
  });
});
