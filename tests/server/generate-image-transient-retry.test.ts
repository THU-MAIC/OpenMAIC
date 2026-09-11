import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A transient transport failure ("fetch failed") used to fail the whole image
// task on the first wobble. The route now retries transport-level errors a
// bounded number of times, while HTTP-level/content-safety rejections pass
// through untouched.

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn(),
}));

vi.mock('@/lib/media/image-providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media/image-providers')>();
  return {
    ...actual,
    generateImage: mocks.generateImage,
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const IMAGE_ENV_PREFIXES = [
  'IMAGE_OPENAI',
  'IMAGE_SEEDREAM',
  'IMAGE_QWEN_IMAGE',
  'IMAGE_NANO_BANANA',
  'IMAGE_MINIMAX',
  'IMAGE_GROK',
  'IMAGE_LEMONADE',
  'IMAGE_COMFYUI',
];

function clearImageEnv() {
  for (const prefix of IMAGE_ENV_PREFIXES) {
    delete process.env[`${prefix}_API_KEY`];
    delete process.env[`${prefix}_BASE_URL`];
    delete process.env[`${prefix}_MODELS`];
    delete process.env[`${prefix}_ENABLED`];
  }
}

function imageRequest(): NextRequest {
  return new NextRequest('http://localhost/api/generate/image', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-image-provider': 'openai-image',
      'x-api-key': 'client-key',
      'x-image-model': 'gpt-image-2',
    },
    body: JSON.stringify({ prompt: 'a cat' }),
  });
}

describe('generate image — transient transport retry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearImageEnv();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.generateImage.mockReset();
  });

  it('retries a fetch-failed transport error and succeeds on the second attempt', async () => {
    mocks.generateImage
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ url: 'https://example.com/img.png', width: 1024, height: 1024 });

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(imageRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ success: true });
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
  });

  it('retries a coded transport error (ECONNRESET cause)', async () => {
    const resetError = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    mocks.generateImage
      .mockRejectedValueOnce(resetError)
      .mockResolvedValueOnce({ url: 'https://example.com/img.png', width: 1024, height: 1024 });

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(imageRequest());

    expect(res.status).toBe(200);
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and surfaces the transport error', async () => {
    mocks.generateImage.mockRejectedValue(new TypeError('fetch failed'));

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(imageRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json).toMatchObject({ success: false, errorCode: 'INTERNAL_ERROR' });
    expect(mocks.generateImage).toHaveBeenCalledTimes(3);
  });

  it('does not retry content-safety rejections', async () => {
    mocks.generateImage.mockRejectedValue(new Error('OutputImageSensitiveContentDetected'));

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(imageRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toMatchObject({ success: false, errorCode: 'CONTENT_SENSITIVE' });
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
  });

  it('does not retry ordinary provider errors', async () => {
    mocks.generateImage.mockRejectedValue(new Error('invalid api key'));

    const { POST } = await import('@/app/api/generate/image/route');
    const res = await POST(imageRequest());

    expect(res.status).toBe(500);
    expect(mocks.generateImage).toHaveBeenCalledTimes(1);
  });
});
