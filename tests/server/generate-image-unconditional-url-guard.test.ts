import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function stubImageEnvAbsent() {
  for (const prefix of IMAGE_ENV_PREFIXES) {
    vi.stubEnv(`${prefix}_API_KEY`, undefined);
    vi.stubEnv(`${prefix}_BASE_URL`, undefined);
    vi.stubEnv(`${prefix}_MODELS`, undefined);
    vi.stubEnv(`${prefix}_ENABLED`, undefined);
  }
  // OpenAI also has a generic image fallback outside the IMAGE_* namespace.
  vi.stubEnv('OPENAI_API_KEY', undefined);
  vi.stubEnv('OPENAI_BASE_URL', undefined);
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
    vi.unstubAllEnvs();
    stubImageEnvAbsent();
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', undefined);
    vi.resetModules();
    mocks.generateImage.mockReset();
    mocks.generateImage.mockResolvedValue({ url: 'https://example.com/img.png' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a private-network base URL when NODE_ENV is not production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { POST } = await import('@/app/api/generate/image/route');

    const res = await POST(
      imageRequest({
        'x-image-provider': 'openai-image',
        'x-api-key': 'client-key',
        'x-image-model': 'gpt-image-2',
        'x-base-url': 'http://192.168.1.10/v1/',
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json).toMatchObject({ success: false, errorCode: 'INVALID_URL' });
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });

  it('still allows a private-network base URL when ALLOW_LOCAL_NETWORKS=true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', 'true');
    const { POST } = await import('@/app/api/generate/image/route');

    const res = await POST(
      imageRequest({
        'x-image-provider': 'openai-image',
        'x-api-key': 'client-key',
        'x-image-model': 'gpt-image-2',
        'x-base-url': 'http://192.168.1.10/v1/',
      }),
    );

    expect(res.status).toBe(200);
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-image',
        apiKey: 'client-key',
        model: 'gpt-image-2',
        baseUrl: 'http://192.168.1.10/v1/',
      }),
      expect.anything(),
    );
  });
});
