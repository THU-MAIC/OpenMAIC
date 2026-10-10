import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  generateWithGlmImage,
  testGlmImageConnectivity,
  resolveCogViewSize,
  DEFAULT_GLM_IMAGE_BASE_URL,
} from '@/lib/media/adapters/glm-image-adapter';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

describe('glm-image-adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('resolveCogViewSize', () => {
    it('snaps 1:1 aspect ratio to 1024x1024', () => {
      expect(resolveCogViewSize({ prompt: 'test', width: 1024, height: 1024 })).toBe('1024x1024');
      expect(resolveCogViewSize({ prompt: 'test', width: 512, height: 512 })).toBe('1024x1024');
    });

    it('snaps landscape 16:9 to 1344x768', () => {
      expect(resolveCogViewSize({ prompt: 'test', width: 1920, height: 1080 })).toBe('1344x768');
      expect(resolveCogViewSize({ prompt: 'test', width: 1280, height: 720 })).toBe('1344x768');
    });

    it('snaps landscape 4:3 to 1152x864', () => {
      expect(resolveCogViewSize({ prompt: 'test', width: 1024, height: 768 })).toBe('1152x864');
    });

    it('snaps portrait 9:16 to 768x1344', () => {
      expect(resolveCogViewSize({ prompt: 'test', width: 1080, height: 1920 })).toBe('768x1344');
    });

    it('snaps portrait 3:4 to 864x1152', () => {
      expect(resolveCogViewSize({ prompt: 'test', width: 768, height: 1024 })).toBe('864x1152');
    });
  });

  describe('generateWithGlmImage', () => {
    it('posts image generation requests to the configured GLM Images endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ url: 'https://cdn.bigmodel.cn/image.png' }] }),
      });

      const result = await generateWithGlmImage(
        {
          providerId: 'glm-image',
          apiKey: 'glm-test-key',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
          model: 'cogview-3-flash',
        },
        { prompt: 'a beautiful sunset', width: 1920, height: 1080 },
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://open.bigmodel.cn/api/paas/v4/images/generations',
        expect.objectContaining({
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer glm-test-key',
          },
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({
        model: 'cogview-3-flash',
        prompt: 'a beautiful sunset',
        n: 1,
        size: '1344x768',
      });

      expect(result).toEqual({
        url: 'https://cdn.bigmodel.cn/image.png',
        base64: undefined,
        width: 1344,
        height: 768,
      });
    });

    it('returns base64 image data when GLM responds inline', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ b64_json: 'aW1hZ2UtYnl0ZXM=' }] }),
      });

      const result = await generateWithGlmImage(
        { providerId: 'glm-image', apiKey: 'glm-test-key', model: 'cogview-4' },
        { prompt: 'inline image' },
      );

      expect(result.base64).toBe('aW1hZ2UtYnl0ZXM=');
      expect(result.url).toBe('data:image/png;base64,aW1hZ2UtYnl0ZXM=');
      expect(result.mimeType).toBe('image/png');
      expect(result.width).toBe(1024);
      expect(result.height).toBe(1024);
    });

    it('throws error when generation API returns an error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid parameter',
        statusText: 'Bad Request',
      });

      await expect(
        generateWithGlmImage(
          { providerId: 'glm-image', apiKey: 'glm-test-key', model: 'cogview-3-flash' },
          { prompt: 'error test' },
        ),
      ).rejects.toThrow('GLM image generation failed (400): Invalid parameter');
    });

    it('throws error when response data contains no image', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      await expect(
        generateWithGlmImage(
          { providerId: 'glm-image', apiKey: 'glm-test-key', model: 'cogview-3-flash' },
          { prompt: 'empty test' },
        ),
      ).rejects.toThrow('GLM returned empty image response');
    });
  });

  describe('testGlmImageConnectivity', () => {
    it('reports success when auth is accepted', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 200 }));

      const result = await testGlmImageConnectivity({
        providerId: 'glm-image',
        apiKey: 'glm-valid-key',
        model: 'cogview-3-flash',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${DEFAULT_GLM_IMAGE_BASE_URL}/images/generations`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer glm-valid-key',
          }),
        }),
      );
      expect(result.success).toBe(true);
      expect(result.message).toBe('Connected to GLM Image');
    });

    it('reports failure on 401 authentication error', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));

      const result = await testGlmImageConnectivity({
        providerId: 'glm-image',
        apiKey: 'glm-bad-key',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('GLM Image auth failed (401)');
    });

    it('reports connectivity transport failure when request throws', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await testGlmImageConnectivity({
        providerId: 'glm-image',
        apiKey: 'glm-key',
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('GLM Image connectivity error: cannot reach the provider');
    });
  });
});
