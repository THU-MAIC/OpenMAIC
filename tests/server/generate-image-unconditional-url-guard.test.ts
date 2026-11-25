import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { setDeploymentConfigForTests } from '@/lib/server/model-config/runtime';

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

function imageRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/generate/image', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: 'a cat' }),
  });
}

describe('generate image provider configuration', () => {
  beforeEach(() => {
    vi.stubEnv('ACCESS_CODE', '');
    vi.stubEnv('ALLOW_LOCAL_NETWORKS', undefined);
    mocks.generateImage.mockReset().mockResolvedValue({ url: 'https://example.com/img.png' });
    setDeploymentConfigForTests({
      layer: {
        source: 'deployment',
        config: {
          providers: {
            photo: {
              preset: 'openai-image',
              apiKey: 'server-key',
              baseUrl: 'http://images.example.com/v1',
              models: ['gpt-image-1'],
            },
          },
          slots: { image: 'photo:gpt-image-1' },
        },
      },
      legacy: false,
      notices: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setDeploymentConfigForTests();
  });

  it.each([undefined, 'true'])(
    'rejects old endpoint headers in development when ALLOW_LOCAL_NETWORKS=%s',
    async (allowLocal) => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('ALLOW_LOCAL_NETWORKS', allowLocal);
      const response = await middleware(
        imageRequest({ 'x-base-url': 'https://provider.example.test' }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('x-base-url');
      expect(mocks.generateImage).not.toHaveBeenCalled();
    },
  );

  it('uses the model and endpoint from the configured image slot', async () => {
    const { POST } = await import('@/app/api/generate/image/route');
    const response = await POST(imageRequest());
    expect(response.status).toBe(200);
    expect(mocks.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'openai-image',
        apiKey: 'server-key',
        model: 'gpt-image-1',
        baseUrl: 'http://images.example.com/v1',
      }),
      expect.anything(),
    );
  });
});
