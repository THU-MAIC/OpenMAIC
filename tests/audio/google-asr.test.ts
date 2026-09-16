import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { transcribeAudio } from '@/lib/audio/asr-providers';
import { ASR_PROVIDERS } from '@/lib/audio/constants';
import { resolveGoogleASRLanguage } from '@/lib/audio/google-asr';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]); // EBML magic + 2 bytes
const webmBlob = () => new Blob([AUDIO], { type: 'audio/webm;codecs=opus' });

function interactionsResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body };
}

describe('Google (Gemini 3.5 Transcribe) ASR', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('is registered: key required, gemini-3.5-transcribe default, auto first, tr-TR listed, webm accepted', () => {
    const p = ASR_PROVIDERS['google-asr'];
    expect(p.requiresApiKey).toBe(true);
    expect(p.defaultModelId).toBe('gemini-3.5-transcribe');
    expect(p.supportedLanguages[0]).toBe('auto');
    expect(p.supportedLanguages).toContain('tr-TR');
    expect(p.supportedFormats).toContain('webm');
    expect(p.defaultBaseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('posts the documented Interactions body (inline base64, bare mime, BCP-47 language) and reads output_text', async () => {
    mockFetch.mockResolvedValueOnce(
      interactionsResponse({
        id: 'x',
        status: 'completed',
        output_text: ' iki üzeri eksi üç ',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'iki üzeri eksi üç' }] }],
      }),
    );

    const result = await transcribeAudio(
      { providerId: 'google-asr', apiKey: 'k', language: 'tr-TR' },
      webmBlob(),
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe('k');
    expect(JSON.parse(init.body)).toEqual({
      model: 'gemini-3.5-transcribe',
      input: [
        { type: 'audio', data: Buffer.from(AUDIO).toString('base64'), mime_type: 'audio/webm' },
      ],
      generation_config: { transcription_config: { language_codes: ['tr-TR'] } },
    });
    expect(result).toEqual({ text: 'iki üzeri eksi üç' });
  });

  it('maps a bare Whisper-style language onto BCP-47 and omits the code for auto', async () => {
    expect(resolveGoogleASRLanguage('tr')).toBe('tr-TR');
    expect(resolveGoogleASRLanguage('en')).toBe('en-US');
    expect(resolveGoogleASRLanguage('zh')).toBe('cmn-Hans-CN');
    expect(resolveGoogleASRLanguage('tr-TR')).toBe('tr-TR');
    expect(resolveGoogleASRLanguage('auto')).toBeUndefined();
    expect(resolveGoogleASRLanguage('')).toBeUndefined();
    expect(resolveGoogleASRLanguage('xx-YY')).toBeUndefined();

    mockFetch.mockResolvedValueOnce(interactionsResponse({ output_text: '' }));
    await transcribeAudio({ providerId: 'google-asr', apiKey: 'k', language: 'auto' }, webmBlob());
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).generation_config).toEqual({
      transcription_config: {},
    });
  });

  it('honours a pinned model and a custom base URL with trailing slash, and accepts a Node Buffer', async () => {
    mockFetch.mockResolvedValueOnce(interactionsResponse({ output_text: 'merhaba' }));
    const result = await transcribeAudio(
      {
        providerId: 'google-asr',
        apiKey: 'k',
        modelId: 'gemini-3.5-transcribe-next',
        baseUrl: 'https://proxy.example/v1beta/',
        language: 'tr-TR',
      },
      Buffer.from(AUDIO),
    );
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://proxy.example/v1beta/interactions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gemini-3.5-transcribe-next');
    expect(body.input[0].mime_type).toBe('audio/webm');
    expect(result.text).toBe('merhaba');
  });

  it('falls back to the text parts in steps[] when output_text is absent', async () => {
    mockFetch.mockResolvedValueOnce(
      interactionsResponse({
        steps: [
          {
            type: 'model_output',
            content: [
              { type: 'text', text: 'üç ' },
              { type: 'text', text: 'çarpı dört' },
            ],
          },
        ],
      }),
    );
    const result = await transcribeAudio(
      { providerId: 'google-asr', apiKey: 'k', language: 'tr-TR' },
      webmBlob(),
    );
    expect(result.text).toBe('üç çarpı dört');
  });

  it('throws when the body carries neither output_text nor text parts', async () => {
    mockFetch.mockResolvedValueOnce(interactionsResponse({ id: 'x', status: 'completed' }));
    await expect(
      transcribeAudio({ providerId: 'google-asr', apiKey: 'k' }, webmBlob()),
    ).rejects.toThrow(/no transcript/);
  });

  it('returns empty text for an empty recording without calling the API', async () => {
    const result = await transcribeAudio(
      { providerId: 'google-asr', apiKey: 'k' },
      new Blob([], { type: 'audio/webm' }),
    );
    expect(result).toEqual({ text: '' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces 429 as a rate-limit error and other failures with the API message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ error: { message: 'quota' } }),
    });
    await expect(
      transcribeAudio({ providerId: 'google-asr', apiKey: 'k' }, webmBlob()),
    ).rejects.toThrow(/rate limited \(429\): quota/);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'unsupported mime' } }),
    });
    await expect(
      transcribeAudio({ providerId: 'google-asr', apiKey: 'k' }, webmBlob()),
    ).rejects.toThrow(/\(400\): unsupported mime/);
  });

  it('refuses to call without an API key (registry says requiresApiKey)', async () => {
    await expect(transcribeAudio({ providerId: 'google-asr' }, webmBlob())).rejects.toThrow(
      /API key required/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
