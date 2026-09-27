import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { generateWithGrokImage } from '@/lib/media/adapters/grok-image-adapter';
import type { ImageGenerationConfig } from '@/lib/media/types';

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

const config: ImageGenerationConfig = {
  providerId: 'grok-image',
  apiKey: 'sk-test',
  baseUrl: 'https://relay.example/v1',
  model: 'grok-imagine-image',
};

/** The opening bytes of a JPEG (`FF D8 FF`), base64-encoded. */
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString(
  'base64',
);

/** The opening bytes of a PNG, base64-encoded. */
const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');

const options = { prompt: 'a classroom diagram', width: 1024, height: 576 };

function respondWith(payload: unknown) {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => payload });
}

describe('grok-image-adapter', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('asks for inline bytes rather than a CDN link', async () => {
    // The link points at x.ai's own CDN, which a deployment may not reach; the
    // follow-up fetch through /api/proxy-media is what failed.
    respondWith({ data: [{ b64_json: JPEG_B64 }] });

    await generateWithGrokImage(config, options);

    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      model: 'grok-imagine-image',
      prompt: 'a classroom diagram',
      n: 1,
      response_format: 'b64_json',
    });
  });

  it('reports a JPEG inline response as image/jpeg, in the URL and in mimeType', async () => {
    respondWith({ data: [{ b64_json: JPEG_B64 }] });

    const result = await generateWithGrokImage(config, options);

    // `b64_json` declares no media type of its own, and a bare `base64` is
    // wrapped as `data:image/png` by the orchestration layer. Carrying the type
    // in the URL keeps the bytes and their type together.
    expect(result).toEqual({
      url: `data:image/jpeg;base64,${JPEG_B64}`,
      base64: JPEG_B64,
      mimeType: 'image/jpeg',
      width: 1024,
      height: 576,
    });
  });

  it('keeps image/png for inline bytes that do not open with the JPEG signature', async () => {
    respondWith({ data: [{ b64_json: PNG_B64 }] });

    const result = await generateWithGrokImage(config, options);

    expect(result.mimeType).toBe('image/png');
    expect(result.url).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('leaves a provider-hosted URL alone and reports no type of its own', async () => {
    respondWith({ data: [{ url: 'https://cdn.example.com/image.png' }] });

    const result = await generateWithGrokImage(config, options);

    // The URL path has a response header for its type, so there is nothing for
    // the adapter to report here.
    expect(result).toEqual({
      url: 'https://cdn.example.com/image.png',
      base64: undefined,
      mimeType: undefined,
      width: 1024,
      height: 576,
    });
  });
});
