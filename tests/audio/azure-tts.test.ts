import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { generateTTS } from '@/lib/audio/tts-providers';

const mockFetch = vi.hoisted(() => vi.fn() as Mock);

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

function audioResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/mpeg' },
    arrayBuffer: async () => new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer,
  };
}

describe('Azure TTS SSML locale', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(audioResponse());
  });

  it('uses the selected non-Chinese voice locale in both SSML language attributes', async () => {
    await generateTTS(
      {
        providerId: 'azure-tts',
        apiKey: 'azure-key',
        baseUrl: 'https://eastus.tts.speech.microsoft.com',
        voice: 'en-US-JennyNeural',
      },
      'Hello',
    );

    const ssml = mockFetch.mock.calls[0][1].body as string;
    expect(ssml).toContain("<speak version='1.0' xml:lang='en-US'>");
    expect(ssml).toContain("<voice xml:lang='en-US' name='en-US-JennyNeural'>");
    expect(ssml).not.toContain("xml:lang='zh-CN'");
  });

  it('keeps zh-CN for the default Chinese voice', async () => {
    await generateTTS(
      {
        providerId: 'azure-tts',
        apiKey: 'azure-key',
        baseUrl: 'https://eastus.tts.speech.microsoft.com',
        voice: 'zh-CN-XiaoxiaoNeural',
      },
      '你好',
    );

    const ssml = mockFetch.mock.calls[0][1].body as string;
    expect(ssml).toContain("<speak version='1.0' xml:lang='zh-CN'>");
    expect(ssml).toContain("<voice xml:lang='zh-CN' name='zh-CN-XiaoxiaoNeural'>");
  });

  it('derives the locale from an otherwise unlisted Azure voice ID', async () => {
    await generateTTS(
      {
        providerId: 'azure-tts',
        apiKey: 'azure-key',
        baseUrl: 'https://eastus.tts.speech.microsoft.com',
        voice: 'fr-FR-DeniseNeural',
      },
      'Bonjour',
    );

    const ssml = mockFetch.mock.calls[0][1].body as string;
    expect(ssml).toContain("xml:lang='fr-FR'");
  });

  it.each([
    ['sr-Latn-RS-SophieNeural', 'sr-Latn-RS'],
    ['iu-Cans-CA-SiqiniqNeural', 'iu-Cans-CA'],
  ])('preserves the script subtag for %s', async (voice, locale) => {
    await generateTTS(
      {
        providerId: 'azure-tts',
        apiKey: 'azure-key',
        baseUrl: 'https://eastus.tts.speech.microsoft.com',
        voice,
      },
      'Hello',
    );

    const ssml = mockFetch.mock.calls[0][1].body as string;
    expect(ssml).toContain(`<speak version='1.0' xml:lang='${locale}'>`);
    expect(ssml).toContain(`<voice xml:lang='${locale}' name='${voice}'>`);
  });
});
