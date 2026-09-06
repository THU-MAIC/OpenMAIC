import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A client-supplied provider base URL must be validated in every environment,
// not only when NODE_ENV === 'production'. The self-hosting escape hatch is
// ALLOW_LOCAL_NETWORKS, which the guard itself honors.

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

function imageRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/generate/image', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: 'a cat' }),
  });
}

describe('generate image — client-supplied base URL guard applies in every environment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearImageEnv();
    delete process.env.ALLOW_LOCAL_NETWORKS;
    mocks.generateImage.mockReset();
    mocks.generateImage.mockResolvedValue({ url: 'https://example.com/img.png' });
  });

  it('rejects a metadata-address base URL when NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { POST } = await import('@/app/api/generate/image/route');

    const res = await POST(
      imageRequest({
        'x-image-provider': 'openai-image',
        'x-api-key': 'client-key',
        'x-image-model': 'gpt-image-2',
        'x-base-url': 'http://169.254.169.254/latest/meta-data/',
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('still allows the same local base URL when ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/image/route');

    const res = await POST(
      imageRequest({
        'x-image-provider': 'openai-image',
        'x-api-key': 'client-key',
        'x-image-model': 'gpt-image-2',
        'x-base-url': 'http://169.254.169.254/latest/meta-data/',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-image',
        model: 'gpt-image-2',
        baseUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
      expect.anything(),
    );
  });
});
