import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock fs — only intercept server-providers.yml so a host-machine YAML config
// can never leak into the route's provider-config (same pattern as
// provider-config.test.ts).
let yamlOverride: string | null = null;

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const isYaml = (p: unknown) => typeof p === 'string' && p.endsWith('server-providers.yml');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
      readFileSync: (p: string, ...args: unknown[]) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
    },
    existsSync: (p: string) => (isYaml(p) ? yamlOverride !== null : actual.existsSync(p)),
    readFileSync: (p: string, ...args: unknown[]) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isYaml(p) ? (yamlOverride ?? '') : (actual.readFileSync as any)(p, ...args),
  };
});

const mocks = vi.hoisted(() => ({ generateTTS: vi.fn() }));

vi.mock('@/lib/audio/tts-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/tts-providers')>();
  return { ...actual, generateTTS: mocks.generateTTS };
});

const TTS_ENV_PREFIXES = [
  'TTS_OPENAI',
  'TTS_AZURE',
  'TTS_GLM',
  'TTS_QWEN',
  'TTS_VOXCPM',
  'TTS_DOUBAO',
  'TTS_ELEVENLABS',
  'TTS_MINIMAX',
  'TTS_LEMONADE',
  'TTS_BROWSER_NATIVE',
];

function clearTtsEnv() {
  for (const prefix of TTS_ENV_PREFIXES) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
    delete process.env[`${prefix}_ENABLED`];
  }
  delete process.env.TTS_QWEN_VOICE_CLONE_MODEL;
}

function ttsRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/generate/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Hello',
      audioId: 'audio-1',
      ...body,
    }),
  });
}

describe('POST /api/generate/tts missing-key contract (#665)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTtsEnv();
    yamlOverride = null;
    mocks.generateTTS.mockReset().mockResolvedValue({ audio: new Uint8Array([1]), format: 'wav' });
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns 400 MISSING_API_KEY for a keyed provider with no key (server or client)', async () => {
    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(ttsRequest({ ttsProviderId: 'openai-tts', ttsVoice: 'alloy' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({
      success: false,
      errorCode: 'MISSING_API_KEY',
    });
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('no longer falls through to a 500 GENERATION_FAILED for a missing key', async () => {
    // Regression guard: before the pre-flight guard, the library threw
    // "API key required for TTS provider: ..." which the route's catch mapped
    // to 500 GENERATION_FAILED. The contract is now a client error.
    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(ttsRequest({ ttsProviderId: 'qwen-tts', ttsVoice: 'Cherry' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.errorCode).not.toBe('GENERATION_FAILED');
    expect(mocks.generateTTS).not.toHaveBeenCalled();
  });

  it('uses a server-configured key (managed provider) so no client key is needed', async () => {
    yamlOverride = 'tts:\n  openai-tts:\n    apiKey: sk-server\n';
    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(ttsRequest({ ttsProviderId: 'openai-tts', ttsVoice: 'alloy' }));

    expect(res.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai-tts', apiKey: 'sk-server' }),
      'Hello',
    );
  });

  it('accepts a client-supplied key for an unmanaged keyed provider', async () => {
    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(
      ttsRequest({
        ttsProviderId: 'openai-tts',
        ttsVoice: 'alloy',
        ttsApiKey: 'client-key',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'openai-tts', apiKey: 'client-key' }),
      'Hello',
    );
  });

  it('does not pre-empt keyless providers (e.g. voxcpm-tts) with the key guard', async () => {
    // The local base URL is the provider's credential path; the key guard must
    // not fire for a keyless provider (and localhost needs the self-host flag).
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(
      ttsRequest({
        ttsProviderId: 'voxcpm-tts',
        ttsVoice: 'auto',
        ttsBaseUrl: 'http://localhost:8000/v1',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.generateTTS).toHaveBeenCalled();
  });

  it('keeps the 500 GENERATION_FAILED envelope for a non-key library failure', async () => {
    // Only the missing-key case moved to 400; genuine downstream failures keep
    // the existing server-error contract.
    mocks.generateTTS.mockRejectedValueOnce(new Error('upstream exploded'));
    const { POST } = await import('@/app/api/generate/tts/route');
    const res = await POST(
      ttsRequest({
        ttsProviderId: 'openai-tts',
        ttsVoice: 'alloy',
        ttsApiKey: 'client-key',
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({ success: false, errorCode: 'GENERATION_FAILED' });
  });
});
