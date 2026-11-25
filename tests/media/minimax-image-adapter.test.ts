import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { generateWithMiniMaxImage } from '@/lib/media/adapters/minimax-image-adapter';
import type { ImageGenerationConfig } from '@/lib/media/types';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const config: ImageGenerationConfig = {
  providerId: 'minimax-image',
  apiKey: 'minimax-test-key',
  baseUrl: 'https://api.minimax.io',
  model: 'image-01',
};

const options = { prompt: 'a solar panel diagram', aspectRatio: '16:9' as const };

function respondWith(payload: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload });
}

describe('minimax-image-adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('upgrades a plain-http result URL to https', async () => {
    // The international site answers with http result URLs, which the
    // provider-result download refuses.
    respondWith({
      data: { image_urls: ['http://cdn.example.com/image_1.jpeg?Expires=1&Signature=s'] },
      base_resp: { status_code: 0 },
    });

    const result = await generateWithMiniMaxImage(config, options);

    expect(result.url).toBe('https://cdn.example.com/image_1.jpeg?Expires=1&Signature=s');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      response_format: 'url',
    });
  });

  it('keeps an https result URL unchanged', async () => {
    respondWith({
      data: { image_urls: ['https://cdn.example.com/image_2.jpeg'] },
      base_resp: { status_code: 0 },
    });

    const result = await generateWithMiniMaxImage(config, options);

    expect(result.url).toBe('https://cdn.example.com/image_2.jpeg');
  });

  it('keeps reporting MiniMax business errors', async () => {
    respondWith({ base_resp: { status_code: 1004, status_msg: 'authentication failed' } });

    await expect(generateWithMiniMaxImage(config, options)).rejects.toThrow(
      'MiniMax Image API error 1004: authentication failed',
    );
  });
});
