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

/** The opening bytes of a JPEG (`FF D8 FF`), base64-encoded. */
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString(
  'base64',
);
/** The opening bytes of a PNG, base64-encoded. */
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

const options = { prompt: 'a solar panel diagram', aspectRatio: '16:9' as const };

function respondWith(payload: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => payload });
}

describe('minimax-image-adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('asks for inline bytes rather than a result URL', async () => {
    respondWith({ data: { image_base64: [JPEG_B64] }, base_resp: { status_code: 0 } });

    await generateWithMiniMaxImage(config, options);

    expect(String(mockFetch.mock.calls[0][0])).toBe('https://api.minimax.io/v1/image_generation');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      model: 'image-01',
      response_format: 'base64',
      aspect_ratio: '16:9',
      n: 1,
    });
  });

  it('returns the inline bytes with their media type and no URL', async () => {
    respondWith({ data: { image_base64: [JPEG_B64] }, base_resp: { status_code: 0 } });

    const result = await generateWithMiniMaxImage(config, options);

    expect(result).toEqual({
      base64: JPEG_B64,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 576,
    });
  });

  it('labels bytes without the JPEG signature as PNG', async () => {
    respondWith({ data: { image_base64: [PNG_B64] }, base_resp: { status_code: 0 } });

    const result = await generateWithMiniMaxImage(config, { prompt: 'a square' });

    expect(result).toMatchObject({ base64: PNG_B64, mimeType: 'image/png' });
  });

  it('fails when no image data comes back', async () => {
    respondWith({ data: { image_base64: [] }, base_resp: { status_code: 0 } });

    await expect(generateWithMiniMaxImage(config, options)).rejects.toThrow(
      'MiniMax Image: no image data returned',
    );
  });

  it('keeps reporting MiniMax business errors', async () => {
    respondWith({ base_resp: { status_code: 1004, status_msg: 'authentication failed' } });

    await expect(generateWithMiniMaxImage(config, options)).rejects.toThrow(
      'MiniMax Image API error 1004: authentication failed',
    );
  });
});
