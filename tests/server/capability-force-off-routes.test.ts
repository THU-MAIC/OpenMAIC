import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Force-off route guards (#665): mirror the TTS contract — a server-disabled
// provider is rejected with 403 PROVIDER_DISABLED before any credential or
// generation logic runs, and a disabled provider is never picked as the
// server-side default.

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
  testImageConnectivity: vi.fn(),
  generateVideo: vi.fn(),
  testVideoConnectivity: vi.fn(),
  transcribeAudio: vi.fn(),
}));

vi.mock('@/lib/media/image-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/image-providers')>();
  return {
    ...actual,
    generateImage: mocks.generateImage,
    testImageConnectivity: mocks.testImageConnectivity,
  };
});

vi.mock('@/lib/media/video-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/video-providers')>();
  return {
    ...actual,
    generateVideo: mocks.generateVideo,
    testVideoConnectivity: mocks.testVideoConnectivity,
  };
});

vi.mock('@/lib/audio/asr-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audio/asr-providers')>();
  return { ...actual, transcribeAudio: mocks.transcribeAudio };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const CAP_ENV_PREFIXES = [
  'IMAGE_OPENAI',
  'IMAGE_SEEDREAM',
  'IMAGE_QWEN_IMAGE',
  'IMAGE_NANO_BANANA',
  'IMAGE_MINIMAX',
  'IMAGE_GROK',
  'IMAGE_LEMONADE',
  'IMAGE_COMFYUI',
  'VIDEO_SEEDANCE',
  'VIDEO_KLING',
  'VIDEO_VEO',
  'VIDEO_SORA',
  'VIDEO_MINIMAX',
  'VIDEO_GROK',
  'VIDEO_HAPPYHORSE',
  'ASR_OPENAI',
  'ASR_QWEN',
  'ASR_AZURE',
  'ASR_FUNASR',
  'ASR_LEMONADE',
  'ASR_BROWSER_NATIVE',
];

function clearCapabilityEnv() {
  for (const prefix of CAP_ENV_PREFIXES) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
    delete process.env[`${prefix}_ENABLED`];
  }
}

function jsonRequest(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function transcriptionRequest(providerId: string): NextRequest {
  const form = new FormData();
  form.append('audio', new File([new Uint8Array([1, 2, 3])], 'test.wav', { type: 'audio/wav' }));
  form.append('providerId', providerId);
  return new NextRequest('http://localhost/api/transcription', {
    method: 'POST',
    body: form,
  });
}

describe('capability force-off route guards (#665)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearCapabilityEnv();
    mocks.generateImage.mockReset().mockResolvedValue({ url: 'https://example.com/img.png' });
    mocks.testImageConnectivity.mockReset().mockResolvedValue({ success: true, message: 'ok' });
    mocks.generateVideo.mockReset().mockResolvedValue({
      url: 'https://example.com/v.mp4',
      width: 1920,
      height: 1080,
      duration: 5,
    });
    mocks.testVideoConnectivity.mockReset().mockResolvedValue({ success: true, message: 'ok' });
    mocks.transcribeAudio.mockReset().mockResolvedValue({ text: 'hello' });
  });

  describe('image', () => {
    it('POST /api/generate/image returns 403 PROVIDER_DISABLED for a force-disabled provider', async () => {
      vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-img');
      vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
      const { POST } = await import('@/app/api/generate/image/route');

      const res = await POST(
        jsonRequest(
          'http://localhost/api/generate/image',
          { prompt: 'a cat' },
          { 'x-image-provider': 'openai-image' },
        ),
      );
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json).toMatchObject({ success: false, errorCode: 'PROVIDER_DISABLED' });
      expect(mocks.generateImage).not.toHaveBeenCalled();
    });

    it('force-off beats a client key on an unmanaged provider', async () => {
      vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
      const { POST } = await import('@/app/api/generate/image/route');

      const res = await POST(
        jsonRequest(
          'http://localhost/api/generate/image',
          { prompt: 'a cat' },
          { 'x-image-provider': 'openai-image', 'x-api-key': 'client-key' },
        ),
      );

      expect(res.status).toBe(403);
      expect(mocks.generateImage).not.toHaveBeenCalled();
    });

    it('does not pick a disabled provider as the server default (MISSING_PROVIDER)', async () => {
      vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-img');
      vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
      const { POST } = await import('@/app/api/generate/image/route');

      // No x-image-provider header ⇒ server default resolution, which skips the
      // disabled provider, leaving nothing configured.
      const res = await POST(
        jsonRequest('http://localhost/api/generate/image', { prompt: 'a cat' }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json).toMatchObject({ success: false, errorCode: 'MISSING_PROVIDER' });
      expect(mocks.generateImage).not.toHaveBeenCalled();
    });

    it('POST /api/verify-image-provider returns 403 for a force-disabled provider', async () => {
      vi.stubEnv('IMAGE_OPENAI_API_KEY', 'sk-img');
      vi.stubEnv('IMAGE_OPENAI_ENABLED', 'false');
      const { POST } = await import('@/app/api/verify-image-provider/route');

      const res = await POST(
        jsonRequest(
          'http://localhost/api/verify-image-provider',
          {},
          { 'x-image-provider': 'openai-image' },
        ),
      );
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json).toMatchObject({ success: false, errorCode: 'PROVIDER_DISABLED' });
      expect(mocks.testImageConnectivity).not.toHaveBeenCalled();
    });
  });

  describe('video', () => {
    it('POST /api/generate/video returns 403 PROVIDER_DISABLED for a force-disabled provider', async () => {
      vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-video');
      vi.stubEnv('VIDEO_GROK_ENABLED', 'false');
      const { POST } = await import('@/app/api/generate/video/route');

      const res = await POST(
        jsonRequest(
          'http://localhost/api/generate/video',
          { prompt: 'a cat' },
          { 'x-video-provider': 'grok-video' },
        ),
      );
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json).toMatchObject({ success: false, errorCode: 'PROVIDER_DISABLED' });
      expect(mocks.generateVideo).not.toHaveBeenCalled();
    });

    it('does not pick a disabled provider as the server default (MISSING_PROVIDER)', async () => {
      vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-video');
      vi.stubEnv('VIDEO_GROK_ENABLED', 'false');
      const { POST } = await import('@/app/api/generate/video/route');

      const res = await POST(
        jsonRequest('http://localhost/api/generate/video', { prompt: 'a cat' }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json).toMatchObject({ success: false, errorCode: 'MISSING_PROVIDER' });
      expect(mocks.generateVideo).not.toHaveBeenCalled();
    });

    it('POST /api/verify-video-provider returns 403 for a force-disabled provider', async () => {
      vi.stubEnv('VIDEO_GROK_API_KEY', 'xai-video');
      vi.stubEnv('VIDEO_GROK_ENABLED', 'false');
      const { POST } = await import('@/app/api/verify-video-provider/route');

      const res = await POST(
        jsonRequest(
          'http://localhost/api/verify-video-provider',
          {},
          { 'x-video-provider': 'grok-video' },
        ),
      );
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json).toMatchObject({ success: false, errorCode: 'PROVIDER_DISABLED' });
      expect(mocks.testVideoConnectivity).not.toHaveBeenCalled();
    });
  });

  describe('asr (transcription)', () => {
    it('POST /api/transcription returns 403 PROVIDER_DISABLED for a force-disabled provider', async () => {
      vi.stubEnv('ASR_OPENAI_API_KEY', 'sk-asr');
      vi.stubEnv('ASR_OPENAI_ENABLED', 'false');
      const { POST } = await import('@/app/api/transcription/route');

      const res = await POST(transcriptionRequest('openai-whisper'));
      const json = await res.json();

      expect(res.status).toBe(403);
      expect(json).toMatchObject({ success: false, errorCode: 'PROVIDER_DISABLED' });
      expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    });

    it('fails loudly instead of guessing a vendor when no enabled ASR backend exists', async () => {
      vi.stubEnv('ASR_OPENAI_API_KEY', 'sk-asr');
      vi.stubEnv('ASR_OPENAI_ENABLED', 'false');
      const { POST } = await import('@/app/api/transcription/route');

      // No providerId in the form and no enabled server backend must not fall
      // through to a hardcoded vendor default.
      const form = new FormData();
      form.append(
        'audio',
        new File([new Uint8Array([1, 2, 3])], 'test.wav', { type: 'audio/wav' }),
      );
      const res = await POST(
        new NextRequest('http://localhost/api/transcription', { method: 'POST', body: form }),
      );
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json).toMatchObject({ success: false, errorCode: 'MISSING_PROVIDER' });
      expect(mocks.transcribeAudio).not.toHaveBeenCalled();
    });

    it('uses an enabled server ASR backend when the client omits providerId', async () => {
      vi.stubEnv('ASR_OPENAI_API_KEY', 'sk-openai');
      vi.stubEnv('ASR_OPENAI_ENABLED', 'false');
      vi.stubEnv('ASR_QWEN_API_KEY', 'sk-qwen');
      const { POST } = await import('@/app/api/transcription/route');

      const form = new FormData();
      form.append(
        'audio',
        new File([new Uint8Array([1, 2, 3])], 'test.wav', { type: 'audio/wav' }),
      );
      const res = await POST(
        new NextRequest('http://localhost/api/transcription', { method: 'POST', body: form }),
      );

      expect(res.status).toBe(200);
      expect(mocks.transcribeAudio).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'qwen-asr', apiKey: 'sk-qwen' }),
        expect.any(File),
      );
    });
  });
});
