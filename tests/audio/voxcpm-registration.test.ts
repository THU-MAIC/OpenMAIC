import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  voxCPMVoiceExists,
  registerVoxCPMVoice,
  bootstrapVoxCPMReferenceClip,
} from '@/lib/audio/voxcpm-registration';

// The registration adapter issues its requests through undici's fetch (with a
// pinned dispatcher) rather than the Next-patched global, so the transport
// double has to stand in for undici.
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});

const cfg = { baseUrl: 'https://voxcpm.test/v1', apiKey: 'k', model: 'voxcpm2' };

beforeEach(() => fetchMock.mockReset());

describe('voxCPMVoiceExists', () => {
  it('lists voices and checks membership', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ voices: ['default', 'voxcpm:voice:abc'] }), {
          status: 200,
        }),
    );
    expect(await voxCPMVoiceExists(cfg, 'voxcpm:voice:abc')).toBe(true);
    expect(await voxCPMVoiceExists(cfg, 'voxcpm:voice:missing')).toBe(false);
  });

  it('returns false when the list call fails', async () => {
    fetchMock.mockImplementation(async () => new Response('', { status: 500 }));
    expect(await voxCPMVoiceExists(cfg, 'voxcpm:voice:abc')).toBe(false);
  });
});

describe('registerVoxCPMVoice', () => {
  it('POSTs multipart name + consent + audio_sample with Bearer auth', async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: true, voice: { name: 'voxcpm:voice:abc' } }), {
          status: 200,
        }),
    );

    const id = await registerVoxCPMVoice(cfg, {
      voiceId: 'voxcpm:voice:abc',
      referenceAudioBase64: btoa('RIFFdata'),
      mimeType: 'audio/wav',
    });

    expect(id).toBe('voxcpm:voice:abc');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://voxcpm.test/v1/audio/voices');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('name')).toBe('voxcpm:voice:abc');
    expect(typeof form.get('consent')).toBe('string');
    expect(form.get('audio_sample')).toBeInstanceOf(Blob);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 400 }));
    await expect(
      registerVoxCPMVoice(cfg, { voiceId: 'v', referenceAudioBase64: btoa('x') }),
    ).rejects.toThrow();
  });
});

describe('bootstrapVoxCPMReferenceClip', () => {
  it('synthesizes the descriptor prompt into base64 wav', async () => {
    const wav = new Uint8Array([82, 73, 70, 70]); // "RIFF"
    fetchMock.mockImplementation(
      async () => new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } }),
    );

    const out = await bootstrapVoxCPMReferenceClip(cfg, {
      design: { identity: 'male teacher', texture: 'warm', delivery: 'calm' },
      language: 'en',
    });

    expect(out.mimeType).toContain('wav');
    expect(typeof out.referenceAudioBase64).toBe('string');
    expect(out.referenceAudioBase64.length).toBeGreaterThan(0);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://voxcpm.test/v1/audio/speech');
    const payload = JSON.parse(String(init.body));
    expect(payload.input).toContain('(male teacher, warm, calm)');
  });
});
